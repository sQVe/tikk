use crate::fact::{
    Attention, AttentionInput, AttentionProblem, AttentionState, AttentionTicket, attention,
    current_claims, current_prs, current_questions,
};
use crate::store::derived_state::{DerivedStates, DerivedStatus, derive_states};
use crate::store::fact_files::{FactScan, read_facts};
use crate::store::id_clash::id_clashes;
use crate::store::store_lock::LockAccess;
use crate::store::sync_result::read_sync_problems;
use crate::store::ticket_files::{TicketScan, read_tickets};
use crate::store::ticket_queries::{QueryEffects, TicketIndex, TicketLookup};
use crate::store::{Store, StoreError};

/// Reads the tickets, the facts, and the saved sync result under one shared lock, and lists what
/// waits on the user. It runs no `gh` and no Git.
pub fn read_attention(store: &Store, effects: &QueryEffects) -> Result<Attention, StoreError> {
    let root = store.root();
    let (scan, facts, sync_problems) = {
        let _lock = (effects.lock_store)(root, LockAccess::Shared)?;

        (
            read_tickets(root)?,
            read_facts(root)?,
            read_sync_problems(root),
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

// A ticket whose ID is in more than one file is left out, as `derive_states` leaves it out.
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
