use serde_json::{Value, json};
use tikk_core::{DerivedStates, StoredTicket};

use crate::output::Output;

pub(crate) fn written_output(ticket: &StoredTicket) -> Output {
    let mut json = row_json(ticket);

    json["path"] = json!(ticket.path.to_string_lossy());
    json["hash"] = json!(ticket.hash);

    Output {
        json,
        text: row_text(ticket),
    }
}

pub(crate) fn row_json(ticket: &StoredTicket) -> Value {
    let fields = &ticket.document.fields;

    json!({
        "id": ticket.id.to_string(),
        "title": fields.title(),
        "kind": fields.kind().as_str(),
        "status": fields.status().as_str(),
        "parent": fields.parent().map(ToString::to_string),
    })
}

pub(crate) fn read_row_json(ticket: &StoredTicket, derived: &DerivedStates) -> Value {
    let mut row = row_json(ticket);

    if let Some(status) = derived.status(ticket) {
        row["derivedStatus"] = json!(status.as_str());
    }

    row
}

pub(crate) fn row_text(ticket: &StoredTicket) -> String {
    row_text_with(ticket, ticket.document.fields.status().as_str())
}

pub(crate) fn read_row_text(ticket: &StoredTicket, derived: &DerivedStates) -> String {
    let stored = ticket.document.fields.status().as_str();

    match derived.status(ticket).map(|status| status.as_str()) {
        Some(status) if status != stored => row_text_with(ticket, &format!("{stored} ({status})")),
        _ => row_text_with(ticket, stored),
    }
}

fn row_text_with(ticket: &StoredTicket, status: &str) -> String {
    let fields = &ticket.document.fields;
    let parent = fields
        .parent()
        .map_or_else(|| "-".to_owned(), ToString::to_string);

    format!(
        "{}  {}  {status}  {parent}  {}",
        ticket.id,
        fields.kind(),
        fields.title()
    )
}
