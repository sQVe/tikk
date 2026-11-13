use std::path::Path;

use crate::fact::{
    AgentName, Claim, FactEvent, FactLine, Timestamp, current_claims, write_fact_line,
};
use crate::store::StoreError;
use crate::store::fact_files::{self, fact_file, read_facts};
use crate::store::identity::Identity;
use crate::store::system;
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

// The claim of an instruction's slice covers a write to the instruction.
pub(crate) fn instruction_slice(fields: &TicketFields) -> Option<&TicketId> {
    if fields.kind() != Kind::Instruction {
        return None;
    }

    fields.parent()
}

// The caller holds the exclusive lock. An agent is refused while another agent holds a live claim
// on the slice, and the write by the holder renews its lease. A person is never refused and renews
// nothing. When the renewal fails after the write, the error is returned and the write stays.
pub(crate) fn write_for_slice<T>(
    root: &Path,
    slice: Option<&TicketId>,
    caller: &Identity,
    effects: &LeaseEffects,
    write: impl FnOnce() -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let (Some(slice), Some(agent)) = (slice, caller.agent.as_ref()) else {
        return write();
    };
    let facts = read_facts(root)?;
    let now = (effects.now)();
    let claim = current_claims(&facts.facts).remove(slice);

    if let Some(claim) = &claim {
        refuse_other_holder(slice, claim, agent, now)?;
    }

    let written = write()?;

    if let Some(claim) = claim.filter(|claim| claim.agent == *agent) {
        append_fact(root, &claim_fact(slice, claim.renewed(now), now), effects)?;
    }

    Ok(written)
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

pub(crate) fn append_fact(
    root: &Path,
    fact: &FactLine,
    effects: &LeaseEffects,
) -> Result<(), StoreError> {
    let path = fact_file(root, fact.at)?;

    (effects.append_line)(&path, &write_fact_line(fact))
}
