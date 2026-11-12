use serde_json::{Value, json};
use tikk_core::StoredTicket;

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
