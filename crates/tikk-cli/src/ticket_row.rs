use serde_json::{Value, json};
use tikk_core::StoredTicket;

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

pub(crate) fn row_text(ticket: &StoredTicket) -> String {
    let fields = &ticket.document.fields;
    let parent = fields
        .parent()
        .map_or_else(|| "-".to_owned(), ToString::to_string);

    format!(
        "{}  {}  {}  {parent}  {}",
        ticket.id,
        fields.kind(),
        fields.status(),
        fields.title()
    )
}
