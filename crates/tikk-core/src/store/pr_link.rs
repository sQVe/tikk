use std::path::Path;

use crate::fact::{FactEvent, FactLine, PrObservation, PullRequest, ShownPr, current_prs};
use crate::store::claim_lease::{LeaseEffects, check_holder, write_for_slice};
use crate::store::fact_files::{append_fact, read_facts};
use crate::store::identity::Identity;
use crate::store::pr_github::{self, PrFailure, RunGh, read_pull_request};
use crate::store::store_lock::{self, LockAccess, StoreLock};
use crate::store::ticket_files::{TicketScan, read_tickets};
use crate::store::ticket_index::find_ticket;
use crate::store::{Store, StoreError};
use crate::ticket::{Kind, TicketId};

#[derive(Clone, Copy)]
pub struct PrEffects {
    pub lock_store: fn(&Path, LockAccess) -> Result<StoreLock, StoreError>,
    pub run_gh: RunGh,
    pub lease: LeaseEffects,
}

impl PrEffects {
    pub fn system() -> Self {
        Self {
            lock_store: store_lock::lock_store,
            run_gh: pr_github::run_gh,
            lease: LeaseEffects::system(),
        }
    }
}

/// Reads the PR through `gh` outside the store lock, then appends a `pr` fact for the slice. An
/// agent is refused while another agent holds a live claim on the slice, before `gh` runs, and
/// the holder's link renews its lease.
pub fn link_pr(
    store: &Store,
    slice: &TicketId,
    pull_request: &PullRequest,
    caller: &Identity,
    effects: &PrEffects,
) -> Result<ShownPr, StoreError> {
    let root = store.root();

    {
        let _lock = (effects.lock_store)(root, LockAccess::Shared)?;

        check_linkable(&read_tickets(root)?, slice)?;

        if let Some(agent) = &caller.agent {
            check_holder(root, slice, agent, (effects.lease.now)())?;
        }
    }

    let observation = read_pull_request(effects.run_gh, pull_request)
        .map_err(|message| gh_failure(slice, pull_request, message))?;
    let _lock = (effects.lock_store)(root, LockAccess::Exclusive)?;
    let scan = read_tickets(root)?;

    check_linkable(&scan, slice)?;

    write_for_slice(root, &scan, Some(slice), caller, &effects.lease, || {
        append_pr(root, slice, observation, &effects.lease)
    })
}

// The caller holds the exclusive lock.
fn append_pr(
    root: &Path,
    slice: &TicketId,
    observation: PrObservation,
    lease: &LeaseEffects,
) -> Result<ShownPr, StoreError> {
    append_pr_fact(root, slice, observation, lease)?;

    // Read the facts again so a tie in time orders by file and line, as `show` does.
    let facts = read_facts(root)?.facts;

    Ok(current_prs(&facts)
        .remove(slice)
        .expect("the slice has the pr fact just appended"))
}

// The caller holds the exclusive lock.
pub(crate) fn append_pr_fact(
    root: &Path,
    slice: &TicketId,
    observation: PrObservation,
    lease: &LeaseEffects,
) -> Result<(), StoreError> {
    let fact = FactLine {
        ticket: slice.clone(),
        at: (lease.now)(),
        event: FactEvent::Pr(observation),
    };

    append_fact(root, &fact, lease.append_line)
}

pub(crate) fn check_linkable(scan: &TicketScan, slice: &TicketId) -> Result<(), StoreError> {
    let kind = find_ticket(scan, slice)?.document.fields.kind();

    if kind != Kind::Slice {
        return Err(StoreError::WrongKind {
            id: slice.to_string(),
            kind,
            allowed: "a slice",
        });
    }

    Ok(())
}

pub(crate) fn gh_failure(
    slice: &TicketId,
    pull_request: &PullRequest,
    message: String,
) -> StoreError {
    StoreError::Gh {
        failures: vec![PrFailure {
            slice: slice.clone(),
            pull_request: pull_request.clone(),
            message,
        }],
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::fs;
    use std::time::{Duration, SystemTime};

    use tempfile::TempDir;

    use super::{PrEffects, link_pr};
    use crate::fact::{
        AgentName, Claim, FactEvent, FactLine, PrObservation, PrState, PullRequest, Timestamp,
        current_claims, current_prs, write_fact_line,
    };
    use crate::store::claim_lease::LeaseEffects;
    use crate::store::fact_files::{append_fact, append_line, read_facts};
    use crate::store::identity::Identity;
    use crate::store::{MachineName, Store, StoreEffects, StoreError, init};
    use crate::ticket::{Kind, TicketId};

    const PLAN: &str = "---\nkind: plan\ntitle: Plan\n---\n";
    const SLICE: &str = "---\nkind: slice\ntitle: Slice\nparent: personal-pppp\ncriteria:\n  - id: s1\n    check: c\n    expected: e\n---\n";
    const OPEN: &str = "{\"number\":7,\"state\":\"OPEN\",\"baseRefName\":\"main\",\"headRefOid\":\"head\",\"mergeCommit\":null}";

    thread_local! {
        static CALLS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    }

    fn open_gh(arguments: &[&str]) -> Result<Vec<u8>, String> {
        CALLS.with(|calls| calls.borrow_mut().push(arguments.join(" ")));

        Ok(OPEN.as_bytes().to_vec())
    }

    fn failing_gh(arguments: &[&str]) -> Result<Vec<u8>, String> {
        CALLS.with(|calls| calls.borrow_mut().push(arguments.join(" ")));

        Err("HTTP 404".to_owned())
    }

    fn one_hour() -> Timestamp {
        Timestamp::from_system_time(SystemTime::UNIX_EPOCH + Duration::from_secs(3600))
    }

    fn effects(run_gh: fn(&[&str]) -> Result<Vec<u8>, String>) -> PrEffects {
        PrEffects {
            run_gh,
            lease: LeaseEffects {
                now: one_hour,
                ..LeaseEffects::system()
            },
            ..PrEffects::system()
        }
    }

    fn id(text: &str) -> TicketId {
        TicketId::parse(text).expect("a valid ID")
    }

    fn pull_request() -> PullRequest {
        PullRequest::new("owner/app", 7).expect("a valid PR")
    }

    fn agent(name: &str) -> Identity {
        Identity {
            agent: AgentName::parse(name),
            ..Identity::default()
        }
    }

    fn store_with_claimed_slice(holder: &str) -> (TempDir, Store) {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let machine = MachineName::parse("test").expect("a valid machine name");
        init(directory.path(), Some(machine), &StoreEffects::system()).expect("init the store");
        let folder = directory.path().join("tickets/personal");
        fs::create_dir_all(&folder).expect("create the project folder");
        fs::write(folder.join("personal-pppp-plan.md"), PLAN).expect("write the plan");
        fs::write(folder.join("personal-kkkk-slice.md"), SLICE).expect("write the slice");
        let start = Timestamp::from_system_time(SystemTime::UNIX_EPOCH);
        let claim = Claim::starting(
            AgentName::parse(holder).expect("a valid name"),
            None,
            None,
            start,
        );
        let fact = FactLine {
            ticket: id("personal-kkkk"),
            at: start,
            event: FactEvent::Claim(claim),
        };
        append_fact(directory.path(), &fact, append_line).expect("append the claim");

        let store = Store {
            root: directory.path().to_path_buf(),
        };

        (directory, store)
    }

    fn fact_count(store: &Store) -> usize {
        read_facts(store.root())
            .expect("read the facts")
            .facts
            .len()
    }

    #[test]
    fn link_by_another_agent_on_a_claimed_slice_is_refused_before_gh_runs() {
        let (_directory, store) = store_with_claimed_slice("manager");

        let error = link_pr(
            &store,
            &id("personal-kkkk"),
            &pull_request(),
            &agent("other"),
            &effects(open_gh),
        )
        .expect_err("another agent holds the slice");

        assert!(
            matches!(&error, StoreError::Claimed { agent, .. } if agent == "manager"),
            "{error:?}"
        );
        assert_eq!(CALLS.with(|calls| calls.take()), Vec::<String>::new());
        assert_eq!(fact_count(&store), 1);
    }

    #[test]
    fn link_by_the_holder_appends_the_pr_and_renews_the_lease() {
        let (_directory, store) = store_with_claimed_slice("manager");

        let shown = link_pr(
            &store,
            &id("personal-kkkk"),
            &pull_request(),
            &agent("manager"),
            &effects(open_gh),
        )
        .expect("the holder links the PR");

        let facts = read_facts(store.root()).expect("read the facts").facts;
        let claim = current_claims(&facts)
            .remove(&id("personal-kkkk"))
            .expect("a claim");
        assert_eq!(shown.state(), PrState::Open);
        assert_eq!(shown.checked_at, one_hour());
        assert_eq!(facts.len(), 3);
        assert!(
            matches!(&facts[1].event, FactEvent::Pr(observation) if observation.head == "head")
        );
        assert_eq!(
            claim.lease_end,
            one_hour().after(Duration::from_secs(4 * 3600))
        );
    }

    #[test]
    fn link_by_a_person_is_never_refused_by_a_claim_and_renews_nothing() {
        let (_directory, store) = store_with_claimed_slice("manager");

        let linked = link_pr(
            &store,
            &id("personal-kkkk"),
            &pull_request(),
            &Identity::default(),
            &effects(open_gh),
        );

        assert!(linked.is_ok(), "{linked:?}");
        assert_eq!(fact_count(&store), 2);
    }

    #[test]
    fn link_takes_only_a_slice_and_runs_no_gh_for_another_kind() {
        let (_directory, store) = store_with_claimed_slice("manager");

        let error = link_pr(
            &store,
            &id("personal-pppp"),
            &pull_request(),
            &Identity::default(),
            &effects(open_gh),
        )
        .expect_err("a plan has no PR");

        assert!(
            matches!(&error, StoreError::WrongKind { id, kind: Kind::Plan, .. } if id == "personal-pppp"),
            "{error:?}"
        );
        assert_eq!(CALLS.with(|calls| calls.take()), Vec::<String>::new());
        assert_eq!(fact_count(&store), 1);
    }

    #[test]
    fn link_returns_the_state_show_selects_when_a_weaker_read_follows_a_stronger_fact() {
        let (directory, store) = store_with_claimed_slice("manager");
        let in_trunk = PrObservation {
            pull_request: pull_request(),
            state: PrState::Merged,
            base: "main".to_owned(),
            head: "head".to_owned(),
            merge_commit: Some("merge".to_owned()),
            in_trunk: true,
        };
        let earlier = FactLine {
            ticket: id("personal-kkkk"),
            at: Timestamp::from_system_time(SystemTime::UNIX_EPOCH),
            event: FactEvent::Pr(in_trunk.clone()),
        };
        append_fact(directory.path(), &earlier, append_line).expect("append the merged fact");

        let shown = link_pr(
            &store,
            &id("personal-kkkk"),
            &pull_request(),
            &Identity::default(),
            &effects(open_gh),
        )
        .expect("the PR is linked");

        assert_eq!(shown.observation, in_trunk);
        assert_eq!(shown.checked_at, one_hour());
    }

    #[test]
    fn link_returns_the_pr_show_selects_when_another_machine_wrote_one_in_the_same_millisecond() {
        let (directory, store) = store_with_claimed_slice("manager");
        let other_pr = PrObservation {
            pull_request: PullRequest::new("owner/app", 8).expect("a valid PR"),
            state: PrState::Open,
            base: "main".to_owned(),
            head: "other".to_owned(),
            merge_commit: None,
            in_trunk: false,
        };
        let tie = FactLine {
            ticket: id("personal-kkkk"),
            at: one_hour(),
            event: FactEvent::Pr(other_pr),
        };
        let later_machine = directory
            .path()
            .join(format!("facts/zeta/{}.jsonl", one_hour().month()));
        append_line(&later_machine, &write_fact_line(&tie)).expect("write the other fact");

        let shown = link_pr(
            &store,
            &id("personal-kkkk"),
            &pull_request(),
            &Identity::default(),
            &effects(open_gh),
        )
        .expect("the PR is linked");

        let facts = read_facts(store.root()).expect("read the facts").facts;
        let selected = current_prs(&facts)
            .remove(&id("personal-kkkk"))
            .expect("the slice has a PR");
        assert_eq!(shown.observation, selected.observation);
        assert_eq!(shown.checked_at, selected.checked_at);
    }

    #[test]
    fn a_failed_gh_read_names_the_pr_and_writes_nothing() {
        let (_directory, store) = store_with_claimed_slice("manager");

        let error = link_pr(
            &store,
            &id("personal-kkkk"),
            &pull_request(),
            &agent("manager"),
            &effects(failing_gh),
        )
        .expect_err("gh fails");

        let StoreError::Gh { failures } = &error else {
            panic!("expected a gh error: {error:?}");
        };
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].slice, id("personal-kkkk"));
        assert_eq!(failures[0].pull_request, pull_request());
        assert!(failures[0].message.contains("HTTP 404"), "{error}");
        assert_eq!(fact_count(&store), 1);
    }
}
