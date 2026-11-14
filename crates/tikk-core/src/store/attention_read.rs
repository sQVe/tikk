use crate::fact::{
    Attention, AttentionInput, AttentionProblem, AttentionState, AttentionTicket, attention,
    current_claims, current_prs, current_questions,
};
use std::path::Path;

use crate::fact::Timestamp;
use crate::store::derived_state::{DerivedStates, DerivedStatus, derive_states};
use crate::store::fact_files::{FactScan, read_facts};
use crate::store::git;
use crate::store::id_clash::id_clashes;
use crate::store::store_lock::{self, LockAccess, StoreLock};
use crate::store::sync_result::read_sync_problems;
use crate::store::system;
use crate::store::ticket_files::{TicketScan, read_tickets};
use crate::store::ticket_index::{TicketIndex, TicketLookup};
use crate::store::{Store, StoreError};

#[derive(Clone, Copy)]
pub struct AttentionEffects {
    pub lock_store: fn(&Path, LockAccess) -> Result<StoreLock, StoreError>,
    pub read_origin: fn(&Path) -> Result<Option<String>, StoreError>,
    pub now: fn() -> Timestamp,
}

impl AttentionEffects {
    pub fn system() -> Self {
        Self {
            lock_store: store_lock::lock_store,
            read_origin: git::read_store_origin,
            now: system::now,
        }
    }
}

/// Reads the tickets, the facts, and the saved sync result under one shared lock, and lists what
/// waits on the user. It runs no `gh` and no network Git; it reads the store's `origin` only to
/// leave out the saved fetch problem of a store with no remote.
pub fn read_attention(store: &Store, effects: &AttentionEffects) -> Result<Attention, StoreError> {
    let root = store.root();
    let has_origin = (effects.read_origin)(root)?.is_some();
    let (scan, facts, sync_problems) = {
        let _lock = (effects.lock_store)(root, LockAccess::Shared)?;

        (
            read_tickets(root)?,
            read_facts(root)?,
            read_sync_problems(root, has_origin),
        )
    };
    let prs = current_prs(&facts.facts);
    let derived = derive_states(&scan, &facts, &prs);
    let mut problems = scan_problems(&scan, &facts);

    problems.extend(sync_problems);

    Ok(attention(AttentionInput {
        tickets: &attention_tickets(&scan, &derived),
        questions: &current_questions(&facts.facts),
        claims: &current_claims(&facts.facts),
        prs: &prs,
        problems,
        now: (effects.now)(),
    }))
}

fn attention_tickets(scan: &TicketScan, derived: &DerivedStates) -> Vec<AttentionTicket> {
    let index = TicketIndex::new(scan);

    scan.tickets
        .iter()
        .filter(|ticket| matches!(index.look_up(&ticket.id), TicketLookup::Found(_)))
        .map(|ticket| {
            let fields = &ticket.document.fields;

            AttentionTicket {
                id: ticket.id.clone(),
                kind: fields.kind(),
                state: attention_state(derived.effective(ticket)),
                parent: fields.parent().cloned(),
                blocked_by: fields.blocked_by().to_vec(),
            }
        })
        .collect()
}

fn attention_state(status: DerivedStatus) -> AttentionState {
    match status {
        DerivedStatus::Open => AttentionState::Open,
        DerivedStatus::Draft | DerivedStatus::AuditBehind => AttentionState::Unfinished,
        DerivedStatus::MergedUnverified => AttentionState::MergedUnverified,
        DerivedStatus::Done | DerivedStatus::Canceled => AttentionState::Finished,
    }
}

fn scan_problems(scan: &TicketScan, facts: &FactScan) -> Vec<AttentionProblem> {
    let tickets = scan
        .errors
        .iter()
        .map(|error| AttentionProblem::TicketUnreadable {
            path: error.path.clone(),
            message: error.message.clone(),
        });
    let clashes = id_clashes(scan)
        .into_iter()
        .map(|clash| AttentionProblem::IdShared {
            id: clash.id,
            paths: clash.paths,
        });
    let lines = facts
        .errors
        .iter()
        .map(|error| AttentionProblem::FactUnreadable {
            path: error.path.clone(),
            line: error.line,
            message: error.message.clone(),
        });

    tickets.chain(clashes).chain(lines).collect()
}

#[cfg(test)]
mod tests {

    use std::path::Path;

    use super::{AttentionEffects, read_attention};
    use crate::fact::{AttentionProblem, AttentionReason};
    use crate::store::StoreError;
    use crate::store::test_support::store_with;

    fn no_origin(_: &Path) -> Result<Option<String>, StoreError> {
        Ok(None)
    }

    fn effects() -> AttentionEffects {
        AttentionEffects {
            read_origin: no_origin,
            ..AttentionEffects::system()
        }
    }

    #[test]
    fn a_loose_open_task_in_the_store_is_an_item() {
        let (_directory, store) = store_with(&[(
            "personal-tttt-renew.md",
            "---\nkind: task\ntitle: Renew the domain\n---\n",
        )]);

        let attention = read_attention(&store, &effects()).expect("the store is read");

        assert_eq!(attention.items.len(), 1, "{attention:?}");
        assert_eq!(attention.items[0].id.to_string(), "personal-tttt");
        assert_eq!(attention.items[0].reason, AttentionReason::LooseTask);
    }

    #[test]
    fn a_ticket_file_that_does_not_parse_is_a_problem() {
        let (_directory, store) = store_with(&[("personal-9999-broken.md", "kind: task\n")]);

        let attention = read_attention(&store, &effects()).expect("the store is read");

        assert!(
            matches!(
                attention.problems.as_slice(),
                [AttentionProblem::TicketUnreadable { path, .. }] if path.ends_with("personal-9999-broken.md")
            ),
            "{attention:?}"
        );
    }
}
