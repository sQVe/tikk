use serde_json::{Value, json};
use tikk_core::{Store, StoreError, TicketFilter, TicketListing};

use crate::command::LsArguments;
use crate::output::Output;
use crate::ticket_row::{row_json, row_text};

pub(crate) fn run(store: &Store, arguments: LsArguments) -> Result<Output, StoreError> {
    let filter = TicketFilter {
        project: arguments.project,
        kind: arguments.kind,
        parent: arguments.parent,
        status: arguments.status,
        search: arguments.search,
    };
    let listing = tikk_core::list_tickets(store, &filter)?;

    Ok(Output {
        json: listing_json(&listing),
        text: listing_text(&listing),
    })
}

fn listing_json(listing: &TicketListing) -> Value {
    let tickets: Vec<Value> = listing.tickets.iter().map(row_json).collect();
    let errors: Vec<Value> = listing
        .errors
        .iter()
        .map(|error| json!({ "path": error.path.to_string_lossy(), "message": error.message }))
        .collect();

    json!({ "tickets": tickets, "errors": errors })
}

fn listing_text(listing: &TicketListing) -> String {
    let rows = listing.tickets.iter().map(row_text);
    let errors = listing
        .errors
        .iter()
        .map(|error| format!("error: {}: {}", error.path.display(), error.message));

    let lines: Vec<String> = rows.chain(errors).collect();

    if lines.is_empty() {
        return "No tickets.".to_owned();
    }

    lines.join("\n")
}
