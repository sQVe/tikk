use serde_json::{Value, json};
use tikk_core::{ShownTicket, Store, StoreError, TicketFields, TicketId};

use crate::output::Output;
use crate::ticket_row::{row_json, row_text};

pub(crate) fn run(store: &Store, id: &TicketId) -> Result<Output, StoreError> {
    let shown = tikk_core::show_ticket(store, id)?;

    Ok(Output {
        json: shown_json(&shown),
        text: shown_text(&shown),
    })
}

fn shown_json(shown: &ShownTicket) -> Value {
    let ticket = &shown.ticket;
    let fields = &ticket.document.fields;
    let children: Vec<Value> = shown.children.iter().map(row_json).collect();

    json!({
        "id": ticket.id.to_string(),
        "project": ticket.id.project().as_str(),
        "kind": fields.kind().as_str(),
        "title": fields.title(),
        "status": fields.status().as_str(),
        "reason": fields.reason(),
        "parent": fields.parent().map(ToString::to_string),
        "rank": fields.rank(),
        "blockedBy": id_texts(fields.blocked_by()),
        "discoveredFrom": fields.discovered_from().map(ToString::to_string),
        "related": id_texts(fields.related()),
        "criteria": criteria_json(fields),
        "path": ticket.path.to_string_lossy(),
        "hash": ticket.hash,
        "body": ticket.document.body,
        "children": children,
        "files": shown.files,
    })
}

fn criteria_json(fields: &TicketFields) -> Vec<Value> {
    fields
        .criteria()
        .iter()
        .map(|criterion| {
            json!({
                "id": criterion.id,
                "check": criterion.check,
                "expected": criterion.expected,
            })
        })
        .collect()
}

fn id_texts(ids: &[TicketId]) -> Vec<String> {
    ids.iter().map(ToString::to_string).collect()
}

fn shown_text(shown: &ShownTicket) -> String {
    let mut lines = vec![row_text(&shown.ticket)];

    if let Some(reason) = shown.ticket.document.fields.reason() {
        lines.push(format!("reason: {reason}"));
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
