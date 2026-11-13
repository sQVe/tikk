use std::path::Path;

use crate::fact::{Claim, ClaimState, FactEvent, FactLine, Timestamp, current_claims};
use crate::store::claim_lease::{LeaseEffects, claim_fact, refuse_other_holder};
use crate::store::claim_sync::{Change, Synced, sync_around};
use crate::store::fact_files::{append_fact, read_facts};
use crate::store::identity::Identity;
use crate::store::sync::SyncEffects;
use crate::store::ticket_files::{StoredTicket, TicketScan};
use crate::store::ticket_link_checks::check_written_links;
use crate::store::ticket_queries::find_ticket;
use crate::store::{Store, StoreError};
use crate::ticket::{Kind, Status, TicketError, TicketId};

#[derive(Clone, Copy)]
pub struct ClaimEffects {
    pub lease: LeaseEffects,
    pub sync: SyncEffects,
}

impl ClaimEffects {
    pub fn system() -> Self {
        Self {
            lease: LeaseEffects::system(),
            sync: SyncEffects::system(),
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
) -> Result<Synced<Claim>, StoreError> {
    // Refused before the sync, so a call without an agent starts no network step.
    if caller.agent.is_none() {
        return Err(StoreError::NoAgent);
    }

    let root = store.root();

    sync_around(root, &effects.sync, |scan| {
        let claim = append_claim(root, scan, id, caller, &effects.lease)?;

        Ok(Change {
            value: claim,
            appended: true,
        })
    })
}

pub fn release_slice(
    store: &Store,
    id: &TicketId,
    caller: &Identity,
    effects: &ClaimEffects,
) -> Result<Synced<Option<Claim>>, StoreError> {
    let root = store.root();

    sync_around(root, &effects.sync, |scan| {
        let ended = append_release(root, scan, id, caller, &effects.lease)?;

        Ok(Change {
            appended: ended.is_some(),
            value: ended,
        })
    })
}

// The caller holds the exclusive lock.
fn append_claim(
    root: &Path,
    scan: &TicketScan,
    id: &TicketId,
    caller: &Identity,
    lease: &LeaseEffects,
) -> Result<Claim, StoreError> {
    let agent = caller.agent.as_ref().ok_or(StoreError::NoAgent)?;

    check_claimable(find_ticket(scan, id)?, scan)?;

    let facts = read_facts(root)?;
    let now = (lease.now)();
    let current = current_claims(&facts.facts).remove(id);

    if let Some(current) = &current {
        refuse_other_holder(id, current, agent, now)?;
    }

    // A renewal by the holder keeps each stored session value that the caller leaves unset.
    let own = current.filter(|current| current.agent == *agent);
    let session = caller
        .session
        .clone()
        .or_else(|| own.as_ref().and_then(|own| own.session.clone()));
    let session_log = caller
        .session_log
        .clone()
        .or_else(|| own.and_then(|own| own.session_log));
    let claim = Claim::starting(agent.clone(), session, session_log, now);

    append_fact(root, &claim_fact(id, claim.clone(), now), lease.append_line)?;

    Ok(claim)
}

// The caller holds the exclusive lock.
fn append_release(
    root: &Path,
    scan: &TicketScan,
    id: &TicketId,
    caller: &Identity,
    lease: &LeaseEffects,
) -> Result<Option<Claim>, StoreError> {
    refuse_other_kinds(find_ticket(scan, id)?)?;

    let facts = read_facts(root)?;
    let now = (lease.now)();
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

    append_fact(root, &release, lease.append_line)?;

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
    use crate::fact::{AgentName, Claim, ClaimState, Timestamp, current_claims};
    use crate::store::claim_lease::LeaseEffects;
    use crate::store::fact_files::read_facts;
    use crate::store::identity::Identity;
    use crate::store::ticket_queries::{QueryEffects, show_ticket};
    use crate::store::ticket_status::mark_done;
    use crate::store::ticket_write::WriteEffects;
    use crate::store::{MachineName, Store, StoreEffects, StoreError, init};
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

    fn claim_value(
        store: &Store,
        slice: &TicketId,
        caller: &Identity,
        effects: &ClaimEffects,
    ) -> Result<Claim, StoreError> {
        claim_slice(store, slice, caller, effects).map(|synced| synced.value)
    }

    fn release_value(
        store: &Store,
        slice: &TicketId,
        caller: &Identity,
        effects: &ClaimEffects,
    ) -> Result<Option<Claim>, StoreError> {
        release_slice(store, slice, caller, effects).map(|synced| synced.value)
    }

    fn store_with_slice() -> (TempDir, Store) {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let machine = MachineName::parse("test").expect("a valid machine name");
        init(directory.path(), Some(machine), &StoreEffects::system()).expect("init the store");
        let folder = directory.path().join("tickets/personal");
        fs::create_dir_all(&folder).expect("create the project folder");

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

            let error = claim_value(&store, &slice, &agent("manager"), &claim_effects())
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

        let claimed = claim_value(&store, &task, &agent("manager"), &claim_effects());
        let released = release_value(&store, &task, &Identity::default(), &claim_effects());

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
    fn a_claim_after_an_unterminated_fragment_starts_its_own_line_and_replays() {
        let (directory, store) = store_with_slice();
        let file = directory.path().join("facts/test/1970-01.jsonl");
        fs::create_dir_all(file.parent().expect("a fact file has a folder"))
            .expect("create the machine folder");
        let fragment = "{\"v\":1,\"kind\":\"cla";
        fs::write(&file, fragment).expect("leave a fragment as a crash would");
        set_clock(0);

        let claim = claim_value(
            &store,
            &id("personal-kkkk"),
            &agent("manager"),
            &claim_effects(),
        )
        .expect("the slice is free");

        let facts = read_facts(directory.path()).expect("the facts are read");
        let text = fs::read_to_string(&file).expect("read the fact file");
        assert!(text.starts_with(&format!("{fragment}\n")), "{text}");
        assert_eq!(
            current_claims(&facts.facts).get(&id("personal-kkkk")),
            Some(&claim)
        );
        assert_eq!(facts.errors.len(), 1, "{:?}", facts.errors);
        assert_eq!(facts.errors[0].line, 1);
    }

    #[test]
    fn a_renewal_keeps_each_stored_session_value_the_caller_leaves_unset() {
        let (_directory, store) = store_with_slice();
        let slice = id("personal-kkkk");
        let first = Identity {
            session: Some("session-1".to_owned()),
            session_log: Some("/logs/session-1.jsonl".to_owned()),
            ..agent("manager")
        };
        let new_session_only = Identity {
            session: Some("session-2".to_owned()),
            ..agent("manager")
        };
        set_clock(0);
        claim_value(&store, &slice, &first, &claim_effects()).expect("the slice is free");

        set_clock(HOUR);
        let kept = claim_value(&store, &slice, &agent("manager"), &claim_effects())
            .expect("the holder renews");
        set_clock(2 * HOUR);
        let mixed = claim_value(&store, &slice, &new_session_only, &claim_effects())
            .expect("the holder renews");

        assert_eq!(kept.session.as_deref(), Some("session-1"));
        assert_eq!(kept.session_log.as_deref(), Some("/logs/session-1.jsonl"));
        assert_eq!(mixed.session.as_deref(), Some("session-2"));
        assert_eq!(mixed.session_log.as_deref(), Some("/logs/session-1.jsonl"));
        assert_eq!(
            mixed.lease_end,
            fake_now().after(Duration::from_secs(4 * HOUR))
        );
    }

    #[test]
    fn a_claim_is_live_before_its_lease_end_and_stale_after_it() {
        let (_directory, store) = store_with_slice();
        let slice = id("personal-kkkk");
        set_clock(1_000);

        let claim = claim_value(&store, &slice, &agent("manager-1"), &claim_effects())
            .expect("the slice is free");

        assert_eq!(
            claim.lease_end,
            fake_now().after(Duration::from_secs(4 * HOUR))
        );

        set_clock(1_000 + 4 * HOUR - 1);
        let refused = claim_value(&store, &slice, &agent("manager-2"), &claim_effects());

        assert_eq!(shown_state(&store), Some(ClaimState::Claimed));
        assert!(
            matches!(&refused, Err(StoreError::Claimed { agent, .. }) if agent == "manager-1"),
            "{refused:?}"
        );

        set_clock(1_000 + 4 * HOUR);
        let taken = claim_value(&store, &slice, &agent("manager-2"), &claim_effects());

        assert!(taken.is_ok(), "{taken:?}");
        assert_eq!(shown_state(&store), Some(ClaimState::Claimed));
    }

    #[test]
    fn the_slice_shows_a_stale_claim_after_the_lease_end() {
        let (_directory, store) = store_with_slice();
        set_clock(0);
        claim_value(
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
        claim_value(
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
        claim_value(&store, &slice, &agent("manager-1"), &claim_effects())
            .expect("the slice is free");

        let by_agent = release_value(&store, &slice, &agent("manager-2"), &claim_effects());
        let by_person = release_value(&store, &slice, &Identity::default(), &claim_effects())
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
