use serde_json::{Value, json};
use tikk_core::{Claim, ClaimEffects, ClaimState, Identity, Store, StoreError, TicketId};

use crate::output::Output;

pub(crate) fn run_claim(
    store: &Store,
    id: &TicketId,
    caller: &Identity,
    effects: &ClaimEffects,
) -> Result<Output, StoreError> {
    let claim = tikk_core::claim_slice(store, id, caller, effects)?;

    Ok(Output {
        json: json!({ "id": id.to_string(), "claim": claim_json(&claim, ClaimState::Claimed) }),
        text: format!("{id}  {}", claim_text(&claim, ClaimState::Claimed)),
    })
}

pub(crate) fn run_release(
    store: &Store,
    id: &TicketId,
    caller: &Identity,
    effects: &ClaimEffects,
) -> Result<Output, StoreError> {
    let ended = tikk_core::release_slice(store, id, caller, effects)?;
    let text = match &ended {
        Some(claim) => format!("{id}  released the claim of {}", claim.agent),
        None => format!("{id}  had no claim"),
    };

    Ok(Output {
        json: json!({ "id": id.to_string(), "released": ended.is_some() }),
        text,
    })
}

pub(crate) fn claim_json(claim: &Claim, state: ClaimState) -> Value {
    json!({
        "agent": claim.agent,
        "session": claim.session,
        "sessionLog": claim.session_log,
        "leaseEnd": claim.lease_end.to_string(),
        "state": state.as_str(),
    })
}

pub(crate) fn claim_text(claim: &Claim, state: ClaimState) -> String {
    format!(
        "{} by {} until {}",
        state.as_str(),
        claim.agent,
        claim.lease_end
    )
}
