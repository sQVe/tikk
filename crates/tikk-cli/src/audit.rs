use serde_json::{Value, json};
use tikk_core::{
    AuditCheck, AuditEffects, AuditReason, AuditRequest, AuditVerdict, Identity, ShownAudit, Store,
    StoreError, Verdict,
};

use crate::output::Output;

pub(crate) fn run(
    store: &Store,
    request: &AuditRequest,
    caller: &Identity,
    effects: &AuditEffects,
) -> Result<Output, StoreError> {
    let shown = tikk_core::audit_slice(store, request, caller, effects)?;
    let id = &request.slice;

    Ok(Output {
        json: json!({ "id": id.to_string(), "audit": audit_json(&shown) }),
        text: format!("{id}  {}", audit_text(&shown)),
    })
}

pub(crate) fn audit_json(shown: &ShownAudit) -> Value {
    let audit = &shown.audit;
    let verdicts: Vec<Value> = audit.verdicts.iter().map(verdict_json).collect();

    json!({
        "repository": audit.repository.as_str(),
        "head": audit.head,
        "ticketHash": audit.ticket_hash,
        "at": shown.at.to_string(),
        "verdicts": verdicts,
    })
}

pub(crate) fn checked_audit_json(check: &AuditCheck) -> Value {
    let mut audit = audit_json(&check.audit);
    let reasons: Vec<Value> = check.reasons.iter().map(reason_json).collect();

    audit["counts"] = json!(check.counts());
    audit["reasons"] = json!(reasons);

    audit
}

pub(crate) fn audit_text(shown: &ShownAudit) -> String {
    let audit = &shown.audit;
    let met = audit
        .verdicts
        .iter()
        .filter(|verdict| verdict.verdict == Verdict::Met)
        .count();

    format!(
        "audit of {} at {}: {met} of {} met, at {}",
        audit.repository,
        audit.head,
        audit.verdicts.len(),
        shown.at
    )
}

pub(crate) fn checked_audit_text(check: &AuditCheck) -> String {
    let reasons: Vec<String> = check
        .reasons
        .iter()
        .map(|reason| match reason.criterion() {
            Some(criterion) => format!("{} {criterion}", reason.as_str()),
            None => reason.as_str().to_owned(),
        })
        .collect();
    let verdict = if check.counts() {
        "counts".to_owned()
    } else {
        format!("does not count ({})", reasons.join(", "))
    };

    format!("{}, {verdict}", audit_text(&check.audit))
}

fn verdict_json(verdict: &AuditVerdict) -> Value {
    json!({
        "criterion": verdict.criterion,
        "check": verdict.check,
        "expected": verdict.expected,
        "verdict": verdict.verdict.as_str(),
        "evidence": verdict.evidence,
    })
}

fn reason_json(reason: &AuditReason) -> Value {
    let mut value = json!({ "reason": reason.as_str() });

    if let Some(criterion) = reason.criterion() {
        value["criterion"] = json!(criterion);
    }

    value
}
