use std::collections::HashMap;
use std::path::Path;

use crate::fact::{PrObservation, PullRequest, ShownPr, current_prs};
use crate::store::derived_state::{DerivedStates, DerivedStatus, derive_states};
use crate::store::fact_files::read_facts;
use crate::store::pr_github::{PrFailure, read_pull_request};
use crate::store::pr_link::{PrEffects, append_pr, check_linkable};
use crate::store::store_lock::LockAccess;
use crate::store::ticket_files::read_tickets;
use crate::store::ticket_queries::{TicketIndex, TicketLookup, shared};
use crate::store::{Store, StoreError};
use crate::ticket::{Kind, TicketId};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshedPr {
    pub slice: TicketId,
    pub pr: ShownPr,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshOutcome {
    pub refreshed: Vec<RefreshedPr>,
    /// The refreshed slices whose open PR has another head than their last audit.
    pub audit_behind: Vec<TicketId>,
}

pub fn refresh_prs(
    store: &Store,
    slice: Option<&TicketId>,
    effects: &PrEffects,
) -> Result<RefreshOutcome, StoreError> {
    let root = store.root();
    let targets = {
        let _lock = (effects.lock_store)(root, LockAccess::Shared)?;

        refresh_targets(root, slice)?
    };
    let mut observed = Vec::new();
    let mut failures = Vec::new();

    for (slice, pull_request) in targets {
        match read_pull_request(effects.run_gh, &pull_request) {
            Ok(observation) => observed.push((slice, observation)),
            Err(message) => failures.push(PrFailure {
                slice,
                pull_request,
                message,
            }),
        }
    }

    let outcome = append_observed(root, observed, effects)?;

    if !failures.is_empty() {
        return Err(StoreError::Gh { failures });
    }

    Ok(outcome)
}

// The caller holds the store lock.
fn refresh_targets(
    root: &Path,
    slice: Option<&TicketId>,
) -> Result<Vec<(TicketId, PullRequest)>, StoreError> {
    let scan = read_tickets(root)?;
    let mut prs = current_prs(&read_facts(root)?.facts);

    if let Some(slice) = slice {
        check_linkable(&scan, slice)?;

        let shown = prs.remove(slice).ok_or_else(|| StoreError::NotLinked {
            id: slice.to_string(),
        })?;

        return Ok(vec![(slice.clone(), shown.observation.pull_request)]);
    }

    let index = TicketIndex::new(&scan);
    let mut linked: Vec<(TicketId, PullRequest)> = prs
        .into_iter()
        .filter(|(_, shown)| !shown.observation.in_trunk)
        .map(|(id, shown)| (id, shown.observation.pull_request))
        .collect();

    linked.sort();
    refuse_shared_ids(&index, linked.iter().map(|(id, _)| id))?;
    linked.retain(|(id, _)| is_slice(&index, id));

    Ok(linked)
}

// A slice that is missing or no longer a slice is skipped, but a shared ID is refused, since tikk
// cannot tell which file the fact belongs to.
fn refuse_shared_ids<'a>(
    index: &TicketIndex<'_>,
    slices: impl IntoIterator<Item = &'a TicketId>,
) -> Result<(), StoreError> {
    for slice in slices {
        if let TicketLookup::Shared(paths) = index.look_up(slice) {
            return Err(shared(slice, &paths));
        }
    }

    Ok(())
}

fn append_observed(
    root: &Path,
    observed: Vec<(TicketId, PrObservation)>,
    effects: &PrEffects,
) -> Result<RefreshOutcome, StoreError> {
    if observed.is_empty() {
        return Ok(RefreshOutcome {
            refreshed: Vec::new(),
            audit_behind: Vec::new(),
        });
    }

    let _lock = (effects.lock_store)(root, LockAccess::Exclusive)?;
    let scan = read_tickets(root)?;
    let index = TicketIndex::new(&scan);
    let current = current_prs(&read_facts(root)?.facts);
    let mut refreshed = Vec::new();

    refuse_shared_ids(&index, observed.iter().map(|(slice, _)| slice))?;

    for (slice, observation) in observed {
        if !still_linked(&index, &current, &slice, &observation.pull_request) {
            continue;
        }

        let pr = append_pr(root, &slice, observation, &effects.lease)?;

        refreshed.push(RefreshedPr { slice, pr });
    }

    let facts = read_facts(root)?.facts;
    let derived = derive_states(&scan, &facts, &current_prs(&facts));
    let audit_behind = refreshed
        .iter()
        .map(|refreshed| refreshed.slice.clone())
        .filter(|slice| is_audit_behind(&index, &derived, slice))
        .collect();

    Ok(RefreshOutcome {
        refreshed,
        audit_behind,
    })
}

fn is_audit_behind(index: &TicketIndex<'_>, derived: &DerivedStates, slice: &TicketId) -> bool {
    let TicketLookup::Found(ticket) = index.look_up(slice) else {
        return false;
    };

    derived.effective(ticket) == DerivedStatus::AuditBehind
}

fn still_linked(
    index: &TicketIndex<'_>,
    current: &HashMap<TicketId, ShownPr>,
    slice: &TicketId,
    pull_request: &PullRequest,
) -> bool {
    let linked = current
        .get(slice)
        .is_some_and(|shown| shown.observation.pull_request == *pull_request);

    linked && is_slice(index, slice)
}

fn is_slice(index: &TicketIndex<'_>, id: &TicketId) -> bool {
    matches!(index.look_up(id), TicketLookup::Found(ticket) if ticket.document.fields.kind() == Kind::Slice)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::fs;
    use std::path::PathBuf;

    use tempfile::TempDir;

    use super::refresh_prs;
    use crate::fact::{
        Audit, FactEvent, FactLine, PrObservation, PrState, PullRequest, Repository, Timestamp,
    };
    use crate::store::fact_files::{append_fact, append_line, read_facts};
    use crate::store::pr_link::PrEffects;
    use crate::store::{MachineName, Store, StoreEffects, StoreError, init};
    use crate::ticket::TicketId;

    const PLAN: &str = "---\nkind: plan\ntitle: Plan\n---\n";
    const SLICE: &str = "---\nkind: slice\ntitle: Slice\nparent: personal-pppp\ncriteria:\n  - id: s1\n    check: c\n    expected: e\n---\n";
    const MERGED: &str = "{\"number\":7,\"state\":\"MERGED\",\"baseRefName\":\"main\",\"headRefOid\":\"head\",\"mergeCommit\":{\"oid\":\"merge\"}}";
    const TRUNK: &str = "{\"defaultBranchRef\":{\"name\":\"main\"}}";

    const OPEN: &str = "{\"number\":7,\"state\":\"OPEN\",\"baseRefName\":\"main\",\"headRefOid\":\"new-head\",\"mergeCommit\":null}";

    thread_local! {
        static ROOT: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
        static CALLS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    }

    fn open_gh(arguments: &[&str]) -> Result<Vec<u8>, String> {
        CALLS.with(|calls| calls.borrow_mut().push(arguments.join(" ")));

        Ok(OPEN.as_bytes().to_vec())
    }

    fn open_effects() -> PrEffects {
        PrEffects {
            run_gh: open_gh,
            ..PrEffects::system()
        }
    }

    fn link_ticket(root: &std::path::Path, ticket: &str, observation: PrObservation) {
        let fact = FactLine {
            ticket: id(ticket),
            at: Timestamp::parse("2026-11-13T01:00:00Z").expect("a valid time"),
            event: FactEvent::Pr(observation),
        };

        append_fact(root, &fact, append_line).expect("append the PR fact");
    }

    fn id(text: &str) -> TicketId {
        TicketId::parse(text).expect("a valid ID")
    }

    fn observation(number: u64) -> PrObservation {
        PrObservation {
            pull_request: PullRequest::new("owner/app", number).expect("a valid PR"),
            state: PrState::Open,
            base: "main".to_owned(),
            head: "head".to_owned(),
            merge_commit: None,
            in_trunk: false,
        }
    }

    fn link(root: &std::path::Path, number: u64, at: &str) {
        let fact = FactLine {
            ticket: id("personal-kkkk"),
            at: Timestamp::parse(at).expect("a valid time"),
            event: FactEvent::Pr(observation(number)),
        };

        append_fact(root, &fact, append_line).expect("append the PR fact");
    }

    fn relinking_gh(arguments: &[&str]) -> Result<Vec<u8>, String> {
        let root = ROOT
            .with(|root| root.borrow().clone())
            .expect("the store is set");

        if arguments[0] == "pr" {
            link(&root, 8, "2026-11-13T02:00:00Z");

            return Ok(MERGED.as_bytes().to_vec());
        }

        Ok(TRUNK.as_bytes().to_vec())
    }

    fn store_with_slice() -> (TempDir, Store) {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let machine = MachineName::parse("test").expect("a valid machine name");
        init(directory.path(), Some(machine), &StoreEffects::system()).expect("init the store");
        let folder = directory.path().join("tickets/personal");
        fs::create_dir_all(&folder).expect("create the project folder");
        fs::write(folder.join("personal-pppp-plan.md"), PLAN).expect("write the plan");
        fs::write(folder.join("personal-kkkk-slice.md"), SLICE).expect("write the slice");

        let store = Store {
            root: directory.path().to_path_buf(),
        };

        (directory, store)
    }

    #[test]
    fn refresh_appends_and_returns_the_state_gh_read_for_a_linked_slice() {
        let (directory, store) = store_with_slice();
        link(directory.path(), 7, "2026-11-13T01:00:00Z");

        let refreshed = refresh_prs(&store, None, &open_effects())
            .expect("the refresh runs")
            .refreshed;

        let facts = read_facts(store.root()).expect("read the facts").facts;
        assert_eq!(CALLS.with(|calls| calls.take()).len(), 1);
        assert_eq!(refreshed.len(), 1);
        assert_eq!(refreshed[0].slice, id("personal-kkkk"));
        assert_eq!(refreshed[0].pr.observation.head, "new-head");
        assert_eq!(facts.len(), 2);
        assert!(
            matches!(&facts[1].event, FactEvent::Pr(observation) if observation.head == "new-head")
        );
    }

    #[test]
    fn refresh_of_all_skips_a_pr_in_trunk_and_a_pr_fact_on_a_ticket_that_is_not_a_slice() {
        let (directory, store) = store_with_slice();
        let in_trunk = PrObservation {
            state: PrState::Merged,
            merge_commit: Some("merge".to_owned()),
            in_trunk: true,
            ..observation(7)
        };
        link_ticket(directory.path(), "personal-kkkk", in_trunk);
        link_ticket(directory.path(), "personal-pppp", observation(8));

        let refreshed = refresh_prs(&store, None, &open_effects())
            .expect("the refresh runs")
            .refreshed;

        let facts = read_facts(store.root()).expect("read the facts").facts;
        assert_eq!(CALLS.with(|calls| calls.take()), Vec::<String>::new());
        assert_eq!(refreshed, Vec::new());
        assert_eq!(facts.len(), 2);
    }

    #[test]
    fn refresh_returns_the_state_show_selects_when_a_weaker_read_follows_a_stronger_fact() {
        let (directory, store) = store_with_slice();
        let in_trunk = PrObservation {
            state: PrState::Merged,
            merge_commit: Some("merge".to_owned()),
            in_trunk: true,
            ..observation(7)
        };
        link_ticket(directory.path(), "personal-kkkk", in_trunk.clone());

        let refreshed = refresh_prs(&store, Some(&id("personal-kkkk")), &open_effects())
            .expect("the refresh runs")
            .refreshed;

        let facts = read_facts(store.root()).expect("read the facts").facts;
        CALLS.with(|calls| calls.take());
        assert_eq!(facts.len(), 2);
        assert_eq!(refreshed.len(), 1);
        assert_eq!(refreshed[0].pr.observation, in_trunk);
        assert_eq!(refreshed[0].pr.checked_at, facts[1].at);
    }

    #[test]
    fn refresh_of_a_slice_without_a_pr_is_refused() {
        let (_directory, store) = store_with_slice();

        let error = refresh_prs(&store, Some(&id("personal-kkkk")), &PrEffects::system())
            .expect_err("the slice has no PR");

        assert!(
            matches!(&error, StoreError::NotLinked { id } if id == "personal-kkkk"),
            "{error:?}"
        );
    }

    #[test]
    fn a_pr_linked_again_while_gh_reads_the_old_one_keeps_the_new_link() {
        let (directory, store) = store_with_slice();
        link(directory.path(), 7, "2026-11-13T01:00:00Z");
        ROOT.with(|root| root.replace(Some(directory.path().to_path_buf())));
        let effects = PrEffects {
            run_gh: relinking_gh,
            ..PrEffects::system()
        };

        let refreshed = refresh_prs(&store, None, &effects)
            .expect("the refresh runs")
            .refreshed;

        let facts = read_facts(store.root()).expect("read the facts").facts;
        assert_eq!(refreshed, Vec::new());
        assert_eq!(facts.len(), 2);
    }

    fn audit_head(root: &std::path::Path, head: &str) {
        let fact = FactLine {
            ticket: id("personal-kkkk"),
            at: Timestamp::parse("2026-11-13T01:30:00Z").expect("a valid time"),
            event: FactEvent::Audit(Audit {
                repository: Repository::parse("owner/app").expect("a valid repository"),
                head: head.to_owned(),
                ticket_hash: "hash".to_owned(),
                verdicts: Vec::new(),
            }),
        };

        append_fact(root, &fact, append_line).expect("append the audit fact");
    }

    #[test]
    fn refresh_lists_a_slice_as_audit_behind_only_when_its_last_audit_saw_another_head() {
        let cases = [
            ("no audit", None, Vec::new()),
            (
                "an audit of the old head",
                Some("head"),
                vec![id("personal-kkkk")],
            ),
            ("an audit of the new head", Some("new-head"), Vec::new()),
        ];

        for (name, audited, expected) in cases {
            let (directory, store) = store_with_slice();
            link(directory.path(), 7, "2026-11-13T01:00:00Z");

            if let Some(head) = audited {
                audit_head(directory.path(), head);
            }

            let outcome = refresh_prs(&store, None, &open_effects()).expect("the refresh runs");

            CALLS.with(|calls| calls.take());
            assert_eq!(outcome.refreshed.len(), 1, "case {name}");
            assert_eq!(outcome.audit_behind, expected, "case {name}");
        }
    }
}
