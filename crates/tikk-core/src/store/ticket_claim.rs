use std::path::Path;

use crate::fact::{Claim, ClaimState, FactEvent, FactLine, Timestamp, current_claims};
use crate::store::claim_lease::{LeaseEffects, append_fact, claim_fact, refuse_other_holder};
use crate::store::fact_files::read_facts;
use crate::store::identity::Identity;
use crate::store::store_lock::{self, LockAccess, StoreLock};
use crate::store::ticket_files::{StoredTicket, TicketScan, read_tickets};
use crate::store::ticket_link_checks::check_written_links;
use crate::store::ticket_queries::find_ticket;
use crate::store::{Store, StoreError};
use crate::ticket::{Kind, Status, TicketError, TicketId};

#[derive(Clone, Copy)]
pub struct ClaimEffects {
    pub lock_store: fn(&Path, LockAccess) -> Result<StoreLock, StoreError>,
    pub lease: LeaseEffects,
}

impl ClaimEffects {
    pub fn system() -> Self {
        Self {
            lock_store: store_lock::lock_store,
            lease: LeaseEffects::system(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShownClaim {
    pub claim: Claim,
    pub state: ClaimState,
}

pub fn claim_slice(
    store: &Store,
    id: &TicketId,
    caller: &Identity,
    effects: &ClaimEffects,
) -> Result<Claim, StoreError> {
    let agent = caller.agent.clone().ok_or(StoreError::NoAgent)?;
    let _lock = (effects.lock_store)(store.root(), LockAccess::Exclusive)?;
    let scan = read_tickets(store.root())?;

    check_claimable(find_ticket(&scan, id)?, &scan)?;

    let facts = read_facts(store.root())?;
    let now = (effects.lease.now)();

    if let Some(current) = current_claims(&facts.facts).get(id) {
        refuse_other_holder(id, current, &agent, now)?;
    }

    let claim = Claim::starting(
        agent,
        caller.session.clone(),
        caller.session_log.clone(),
        now,
    );

    append_fact(
        store.root(),
        &claim_fact(id, claim.clone(), now),
        &effects.lease,
    )?;

    Ok(claim)
}

pub fn release_slice(
    store: &Store,
    id: &TicketId,
    caller: &Identity,
    effects: &ClaimEffects,
) -> Result<Option<Claim>, StoreError> {
    let _lock = (effects.lock_store)(store.root(), LockAccess::Exclusive)?;
    let scan = read_tickets(store.root())?;

    refuse_other_kinds(find_ticket(&scan, id)?)?;

    let facts = read_facts(store.root())?;
    let now = (effects.lease.now)();
    let Some(current) = current_claims(&facts.facts).remove(id) else {
        return Ok(None);
    };

    if let Some(agent) = &caller.agent {
        refuse_other_holder(id, &current, agent, now)?;
    }

    let release = FactLine {
        ticket: id.clone(),
        at: now,
        event: FactEvent::Release {
            agent: caller.agent.clone(),
        },
    };

    append_fact(store.root(), &release, &effects.lease)?;

    Ok(Some(current))
}

// The caller holds the store lock.
pub(crate) fn shown_claim(
    root: &Path,
    ticket: &StoredTicket,
    now: Timestamp,
) -> Result<Option<ShownClaim>, StoreError> {
    if ticket.document.fields.kind() != Kind::Slice {
        return Ok(None);
    }

    let facts = read_facts(root)?;

    Ok(current_claims(&facts.facts)
        .remove(&ticket.id)
        .map(|claim| ShownClaim {
            state: claim.state(now),
            claim,
        }))
}

fn check_claimable(ticket: &StoredTicket, scan: &TicketScan) -> Result<(), StoreError> {
    let fields = &ticket.document.fields;

    refuse_other_kinds(ticket)?;

    if fields.status() != Status::Open {
        return Err(TicketError::invalid(
            "status",
            format!(
                "is {}, and only an open slice can be claimed",
                fields.status()
            ),
        )
        .into());
    }

    check_written_links(&ticket.id, fields, scan)?;

    if fields.criteria().is_empty() {
        return Err(TicketError::invalid(
            "criteria",
            "is empty, and a slice needs at least one criterion before a claim",
        )
        .into());
    }

    Ok(())
}

fn refuse_other_kinds(ticket: &StoredTicket) -> Result<(), StoreError> {
    let kind = ticket.document.fields.kind();

    if kind == Kind::Slice {
        return Ok(());
    }

    Err(StoreError::WrongKind {
        id: ticket.id.to_string(),
        kind,
        allowed: "a slice",
    })
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs;
    use std::path::Path;
    use std::time::{Duration, SystemTime};

    use tempfile::TempDir;

    use super::{ClaimEffects, claim_slice, release_slice};
    use crate::fact::{AgentName, ClaimState, Timestamp};
    use crate::store::claim_lease::LeaseEffects;
    use crate::store::identity::Identity;
    use crate::store::ticket_queries::{QueryEffects, show_ticket};
    use crate::store::ticket_status::mark_done;
    use crate::store::ticket_write::WriteEffects;
    use crate::store::{Store, StoreError};
    use crate::ticket::{Kind, Status, TicketError, TicketId};

    const PLAN: &str = "---\nkind: plan\ntitle: Plan\n---\n";
    const SLICE: &str = "---\nkind: slice\ntitle: Slice\nparent: personal-pppp\ncriteria:\n  - id: s1\n    check: c\n    expected: e\n---\n";
    const INSTRUCTION: &str = "---\nkind: instruction\ntitle: Step\nparent: personal-kkkk\n---\n";
    const HOUR: u64 = 60 * 60;

    thread_local! {
        static SECONDS: Cell<u64> = const { Cell::new(0) };
    }

    fn fake_now() -> Timestamp {
        Timestamp::from_system_time(SystemTime::UNIX_EPOCH + Duration::from_secs(SECONDS.get()))
    }

    fn set_clock(seconds: u64) {
        SECONDS.set(seconds);
    }

    fn failing_append(path: &Path, _: &str) -> Result<(), StoreError> {
        Err(StoreError::Io {
            action: "append to",
            path: path.to_path_buf(),
            source: std::io::Error::other("disk full"),
        })
    }

    fn lease() -> LeaseEffects {
        LeaseEffects {
            now: fake_now,
            ..LeaseEffects::system()
        }
    }

    fn claim_effects() -> ClaimEffects {
        ClaimEffects {
            lease: lease(),
            ..ClaimEffects::system()
        }
    }

    fn store_with_slice() -> (TempDir, Store) {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let folder = directory.path().join("tickets/personal");
        fs::create_dir_all(&folder).expect("create the project folder");
        fs::create_dir_all(directory.path().join(".git")).expect("create the Git folder");
        fs::write(directory.path().join(".git/tikk-machine"), "test\n")
            .expect("save the machine name");

        for (name, text) in [
            ("personal-pppp-plan.md", PLAN),
            ("personal-kkkk-slice.md", SLICE),
            ("personal-iiii-step.md", INSTRUCTION),
        ] {
            fs::write(folder.join(name), text).expect("write a ticket");
        }

        let store = Store {
            root: directory.path().to_path_buf(),
        };

        (directory, store)
    }

    fn agent(name: &str) -> Identity {
        Identity {
            agent: AgentName::parse(name),
            ..Identity::default()
        }
    }

    fn id(text: &str) -> TicketId {
        TicketId::parse(text).expect("a valid ID")
    }

    fn shown_state(store: &Store) -> Option<ClaimState> {
        let effects = QueryEffects {
            now: fake_now,
            ..QueryEffects::system()
        };

        show_ticket(store, &id("personal-kkkk"), &effects)
            .expect("the slice is shown")
            .claim
            .map(|shown| shown.state)
    }

    fn write_ticket(directory: &TempDir, name: &str, text: &str) {
        fs::write(directory.path().join("tickets/personal").join(name), text)
            .expect("write a ticket");
    }

    #[test]
    fn claim_names_the_field_that_fails_strict_validation_and_writes_nothing() {
        let (directory, store) = store_with_slice();
        let criteria = "criteria:\n  - id: s1\n    check: c\n    expected: e\n";
        let cases = [
            (
                "personal-aaaa-bare.md",
                "---\nkind: slice\ntitle: Bare\nparent: personal-pppp\n---\n".to_owned(),
                "criteria",
            ),
            (
                "personal-bbbb-draft.md",
                format!(
                    "---\nkind: slice\ntitle: Draft\nstatus: draft\nparent: personal-pppp\n{criteria}---\n"
                ),
                "status",
            ),
            (
                "personal-cccc-blocked.md",
                format!(
                    "---\nkind: slice\ntitle: Blocked\nparent: personal-pppp\nblockedBy: [personal-zzzz]\n{criteria}---\n"
                ),
                "blockedBy",
            ),
        ];
        set_clock(0);

        for (name, text, expected) in cases {
            write_ticket(&directory, name, &text);
            let slice = id(&name[..13]);

            let error = claim_slice(&store, &slice, &agent("manager"), &claim_effects())
                .expect_err("the slice fails strict validation");

            assert!(
                matches!(&error, StoreError::Ticket(TicketError::Invalid { field, .. }) if field == expected),
                "case {expected}: {error:?}"
            );
        }
        assert!(!directory.path().join("facts").exists());
    }

    #[test]
    fn claim_and_release_refuse_a_ticket_that_is_not_a_slice() {
        let (directory, store) = store_with_slice();
        write_ticket(
            &directory,
            "personal-tttt-task.md",
            "---\nkind: task\ntitle: Task\nparent: personal-pppp\n---\n",
        );
        let task = id("personal-tttt");
        set_clock(0);

        let claimed = claim_slice(&store, &task, &agent("manager"), &claim_effects());
        let released = release_slice(&store, &task, &Identity::default(), &claim_effects());

        for (name, result) in [
            ("claim", claimed.map(|_| ())),
            ("release", released.map(|_| ())),
        ] {
            assert!(
                matches!(
                    &result,
                    Err(StoreError::WrongKind {
                        kind: Kind::Task,
                        allowed: "a slice",
                        ..
                    })
                ),
                "case {name}: {result:?}"
            );
        }
        assert!(!directory.path().join("facts").exists());
    }

    #[test]
    fn a_claim_is_live_before_its_lease_end_and_stale_after_it() {
        let (_directory, store) = store_with_slice();
        let slice = id("personal-kkkk");
        set_clock(1_000);

        let claim = claim_slice(&store, &slice, &agent("manager-1"), &claim_effects())
            .expect("the slice is free");

        assert_eq!(
            claim.lease_end,
            fake_now().after(Duration::from_secs(4 * HOUR))
        );

        set_clock(1_000 + 4 * HOUR - 1);
        let refused = claim_slice(&store, &slice, &agent("manager-2"), &claim_effects());

        assert_eq!(shown_state(&store), Some(ClaimState::Claimed));
        assert!(
            matches!(&refused, Err(StoreError::Claimed { agent, .. }) if agent == "manager-1"),
            "{refused:?}"
        );

        set_clock(1_000 + 4 * HOUR);
        let taken = claim_slice(&store, &slice, &agent("manager-2"), &claim_effects());

        assert!(taken.is_ok(), "{taken:?}");
        assert_eq!(shown_state(&store), Some(ClaimState::Claimed));
    }

    #[test]
    fn the_slice_shows_a_stale_claim_after_the_lease_end() {
        let (_directory, store) = store_with_slice();
        set_clock(0);
        claim_slice(
            &store,
            &id("personal-kkkk"),
            &agent("manager"),
            &claim_effects(),
        )
        .expect("the slice is free");

        set_clock(4 * HOUR);

        assert_eq!(shown_state(&store), Some(ClaimState::StaleClaim));
    }

    #[test]
    fn a_failed_renewal_reports_the_error_and_keeps_the_write() {
        let (directory, store) = store_with_slice();
        set_clock(0);
        claim_slice(
            &store,
            &id("personal-kkkk"),
            &agent("manager"),
            &claim_effects(),
        )
        .expect("the slice is free");
        let effects = WriteEffects {
            lease: LeaseEffects {
                append_line: failing_append,
                now: fake_now,
            },
            ..WriteEffects::system()
        };

        let result = mark_done(&store, &id("personal-iiii"), &agent("manager"), &effects);

        assert!(
            matches!(
                &result,
                Err(StoreError::Io {
                    action: "append to",
                    ..
                })
            ),
            "{result:?}"
        );
        let text = fs::read_to_string(
            directory
                .path()
                .join("tickets/personal/personal-iiii-step.md"),
        )
        .expect("read the instruction");
        assert!(
            text.contains(&format!("status: {}", Status::Done)),
            "{text}"
        );
    }

    #[test]
    fn release_by_a_person_ends_a_live_claim_and_by_another_agent_does_not() {
        let (_directory, store) = store_with_slice();
        let slice = id("personal-kkkk");
        set_clock(0);
        claim_slice(&store, &slice, &agent("manager-1"), &claim_effects())
            .expect("the slice is free");

        let by_agent = release_slice(&store, &slice, &agent("manager-2"), &claim_effects());
        let by_person = release_slice(&store, &slice, &Identity::default(), &claim_effects())
            .expect("a person ends any claim");

        assert!(
            matches!(&by_agent, Err(StoreError::Claimed { .. })),
            "{by_agent:?}"
        );
        assert_eq!(
            by_person.map(|claim| claim.agent.to_string()),
            Some("manager-1".to_owned())
        );
        assert_eq!(shown_state(&store), None);
    }
}
