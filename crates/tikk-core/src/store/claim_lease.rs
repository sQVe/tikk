use std::path::Path;

use crate::fact::{AgentName, Claim, FactEvent, FactLine, Timestamp, current_claims};
use crate::store::StoreError;
use crate::store::fact_files::{self, append_fact, read_facts};
use crate::store::identity::Identity;
use crate::store::system;
use crate::store::ticket_files::TicketScan;
use crate::store::ticket_queries::ticket_path;
use crate::ticket::{Kind, TicketFields, TicketId};

#[derive(Clone, Copy)]
pub struct LeaseEffects {
    pub now: fn() -> Timestamp,
    pub append_line: fn(&Path, &str) -> Result<(), StoreError>,
}

impl LeaseEffects {
    pub fn system() -> Self {
        Self {
            now: system::now,
            append_line: fact_files::append_line,
        }
    }
}

pub(crate) fn instruction_slice(fields: &TicketFields) -> Option<&TicketId> {
    if fields.kind() != Kind::Instruction {
        return None;
    }

    fields.parent()
}

// The caller holds the exclusive lock, and `scan` is its read of the tickets. An agent is refused
// while another agent holds a live claim on the slice, or while the slice's ID is in more than one
// file, and the write by the holder renews its lease. A person is never refused and renews
// nothing. When the renewal fails after the write, the error is returned and the write stays.
pub(crate) fn write_for_slice<T>(
    root: &Path,
    scan: &TicketScan,
    slice: Option<&TicketId>,
    caller: &Identity,
    effects: &LeaseEffects,
    write: impl FnOnce() -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let (Some(slice), Some(agent)) = (slice, caller.agent.as_ref()) else {
        return write();
    };

    refuse_shared_id(scan, slice)?;

    let now = (effects.now)();
    let claim = check_holder(root, slice, agent, now)?;
    let written = write()?;

    if let Some(claim) = claim.filter(|claim| claim.agent == *agent) {
        append_fact(
            root,
            &claim_fact(slice, claim.renewed(now), now),
            effects.append_line,
        )?;
    }

    Ok(written)
}

// The caller holds the store lock. Returns the slice's current claim, unless another agent holds
// it live.
pub(crate) fn check_holder(
    root: &Path,
    slice: &TicketId,
    agent: &AgentName,
    now: Timestamp,
) -> Result<Option<Claim>, StoreError> {
    let facts = read_facts(root)?;
    let claim = current_claims(&facts.facts).remove(slice);

    if let Some(claim) = &claim {
        refuse_other_holder(slice, claim, agent, now)?;
    }

    Ok(claim)
}

fn refuse_shared_id(scan: &TicketScan, slice: &TicketId) -> Result<(), StoreError> {
    match ticket_path(scan, slice) {
        Err(error @ StoreError::IdShared { .. }) => Err(error),
        _ => Ok(()),
    }
}

pub(crate) fn refuse_other_holder(
    slice: &TicketId,
    claim: &Claim,
    agent: &AgentName,
    now: Timestamp,
) -> Result<(), StoreError> {
    if claim.agent == *agent || !claim.is_live(now) {
        return Ok(());
    }

    Err(StoreError::Claimed {
        id: slice.to_string(),
        agent: claim.agent.to_string(),
        lease_end: claim.lease_end.to_string(),
    })
}

pub(crate) fn claim_fact(slice: &TicketId, claim: Claim, now: Timestamp) -> FactLine {
    FactLine {
        ticket: slice.clone(),
        at: now,
        event: FactEvent::Claim(claim),
    }
}
