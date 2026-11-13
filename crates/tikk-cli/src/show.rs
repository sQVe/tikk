use serde_json::{Value, json};
use tikk_core::{QueryEffects, ShownTicket, Store, StoreError, TicketId};

use crate::claim::{claim_json, claim_text};
use crate::output::Output;
use crate::pr::{pr_json, pr_text};
use crate::ticket_row::{row_json, row_text};

pub(crate) fn run(
    store: &Store,
    id: &TicketId,
    effects: &QueryEffects,
) -> Result<Output, StoreError> {
    let shown = tikk_core::show_ticket(store, id, effects)?;

    Ok(Output {
        json: shown_json(&shown),
        text: shown_text(&shown),
    })
}

fn shown_json(shown: &ShownTicket) -> Value {
    let ticket = &shown.ticket;
    let fields = &ticket.document.fields;
    let children: Vec<Value> = shown.children.iter().map(row_json).collect();
    let claim = shown
        .claim
        .as_ref()
        .map(|shown| claim_json(&shown.claim, shown.state));

    json!({
        "id": ticket.id.to_string(),
        "project": ticket.id.project().as_str(),
        "kind": fields.kind(),
        "title": fields.title(),
        "status": fields.status(),
        "reason": fields.reason(),
        "parent": fields.parent(),
        "rank": fields.rank(),
        "blockedBy": fields.blocked_by(),
        "discoveredFrom": fields.discovered_from(),
        "related": fields.related(),
        "criteria": fields.criteria(),
        "path": ticket.path.to_string_lossy(),
        "hash": ticket.hash,
        "body": ticket.document.body,
        "document": ticket.text,
        "children": children,
        "files": shown.files,
        "claim": claim,
        "pr": shown.pr.as_ref().map(pr_json),
    })
}

fn shown_text(shown: &ShownTicket) -> String {
    let fields = &shown.ticket.document.fields;
    let mut lines = vec![row_text(&shown.ticket)];

    if let Some(reason) = fields.reason() {
        lines.push(format!("reason: {reason}"));
    }

    if !fields.blocked_by().is_empty() {
        let blockers: Vec<String> = fields
            .blocked_by()
            .iter()
            .map(ToString::to_string)
            .collect();

        lines.push(format!("blockedBy: {}", blockers.join(", ")));
    }

    if let Some(claim) = &shown.claim {
        lines.push(format!("claim: {}", claim_text(&claim.claim, claim.state)));
    }

    if let Some(pr) = &shown.pr {
        lines.push(format!("pr: {}", pr_text(pr)));
    }

    lines.extend(
        shown
            .children
            .iter()
            .map(|child| format!("  {}", row_text(child))),
    );

    let body = shown.ticket.document.body.trim_end();

    if !body.is_empty() {
        lines.push(String::new());
        lines.push(body.to_owned());
    }

    lines.join("\n")
}
