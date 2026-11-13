use std::path::PathBuf;

use serde_json::{Value, json};
use tikk_core::{ClaimState, Hold, ReadyQueue, ReadySlice, SkippedSlice};

use crate::claim::{claim_json, claim_text};
use crate::output::Output;
use crate::pr::{stack_parent_json, stack_parent_text};
use crate::ticket_row::{row_json, row_text};

pub(crate) fn ready_output(queue: &ReadyQueue) -> Output {
    Output {
        json: queue_json(queue),
        text: queue_text(queue),
    }
}

fn queue_json(queue: &ReadyQueue) -> Value {
    let candidates: Vec<Value> = queue.candidates.iter().map(candidate_json).collect();
    let skipped: Vec<Value> = queue.skipped.iter().map(skipped_json).collect();
    let ticket_errors = queue
        .errors
        .iter()
        .map(|error| json!({ "path": error.path.to_string_lossy(), "message": error.message }));
    let fact_errors = queue.fact_errors.iter().map(|error| {
        json!({
            "path": error.path.to_string_lossy(),
            "line": error.line,
            "message": error.message,
        })
    });
    let errors: Vec<Value> = ticket_errors.chain(fact_errors).collect();

    json!({ "candidates": candidates, "skipped": skipped, "errors": errors })
}

fn candidate_json(candidate: &ReadySlice) -> Value {
    let mut row = row_json(&candidate.ticket);

    row["stackParent"] = candidate
        .stack_parent
        .as_ref()
        .map_or(Value::Null, stack_parent_json);

    row
}

fn skipped_json(skipped: &SkippedSlice) -> Value {
    let mut row = row_json(&skipped.ticket);
    let holds: Vec<Value> = skipped.holds.iter().map(hold_json).collect();

    row["holds"] = json!(holds);

    row
}

fn hold_json(hold: &Hold) -> Value {
    match hold {
        Hold::Draft => json!({ "reason": "draft" }),
        Hold::BlockedBy {
            blocker,
            via,
            state,
        } => json!({
            "reason": "blockedBy",
            "blocker": blocker,
            "via": via,
            "state": state.as_str(),
        }),
        Hold::Parent { parent, state } => json!({
            "reason": "parent",
            "parent": parent,
            "state": state.as_str(),
        }),
        Hold::Claimed(claim) => json!({
            "reason": "claimed",
            "claim": claim_json(claim, ClaimState::Claimed),
        }),
        Hold::IdShared { paths } => json!({
            "reason": "idShared",
            "paths": paths_text(paths),
        }),
    }
}

fn queue_text(queue: &ReadyQueue) -> String {
    let mut lines = Vec::new();

    for candidate in &queue.candidates {
        lines.push(row_text(&candidate.ticket));
        lines.extend(
            candidate
                .stack_parent
                .as_ref()
                .map(|parent| format!("  {}", stack_parent_text(parent))),
        );
    }

    for skipped in &queue.skipped {
        lines.push(format!("skipped: {}", row_text(&skipped.ticket)));
        lines.extend(
            skipped
                .holds
                .iter()
                .map(|hold| format!("  {}", hold_text(hold))),
        );
    }

    lines.extend(
        queue
            .errors
            .iter()
            .map(|error| format!("error: {}: {}", error.path.display(), error.message)),
    );
    lines.extend(queue.fact_errors.iter().map(|error| {
        format!(
            "error: {}:{}: {}",
            error.path.display(),
            error.line,
            error.message
        )
    }));

    if lines.is_empty() {
        return "No slices.".to_owned();
    }

    lines.join("\n")
}

fn hold_text(hold: &Hold) -> String {
    match hold {
        Hold::Draft => "draft".to_owned(),
        Hold::BlockedBy {
            blocker,
            via: Some(plan),
            state,
        } => format!("blocked by {blocker} through {plan} ({})", state.as_str()),
        Hold::BlockedBy {
            blocker,
            via: None,
            state,
        } => format!("blocked by {blocker} ({})", state.as_str()),
        Hold::Parent { parent, state } => {
            format!("its plan {parent} is {}", state.as_str())
        }
        Hold::Claimed(claim) => claim_text(claim, ClaimState::Claimed),
        Hold::IdShared { paths } => format!("idShared: {}", paths_text(paths).join("  ")),
    }
}

fn paths_text(paths: &[PathBuf]) -> Vec<String> {
    paths
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}
