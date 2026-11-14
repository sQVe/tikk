use serde_json::{Value, json};
use tikk_core::{IdClash, QueryEffects, Store, StoreError, TicketFilter, TicketListing};

use crate::command::LsArguments;
use crate::output::Output;
use crate::ticket_row::{read_row_json, read_row_text};

pub(crate) fn run(
    store: &Store,
    arguments: LsArguments,
    effects: &QueryEffects,
) -> Result<Output, StoreError> {
    let filter = TicketFilter {
        project: arguments.project,
        kind: arguments.kind,
        parent: arguments.parent,
        status: arguments.status,
        search: arguments.search,
    };
    let listing = tikk_core::list_tickets(store, &filter, effects)?;

    Ok(Output {
        json: listing_json(&listing),
        text: listing_text(&listing),
    })
}

fn listing_json(listing: &TicketListing) -> Value {
    let tickets: Vec<Value> = listing
        .tickets
        .iter()
        .map(|ticket| read_row_json(ticket, &listing.derived))
        .collect();
    let unreadable = listing
        .errors
        .iter()
        .map(|error| json!({ "path": error.path.to_string_lossy(), "message": error.message }));
    let clashes = listing.clashes.iter().map(|clash| {
        json!({
            "code": "idShared",
            "id": clash.id,
            "paths": clash_paths(clash),
            "message": clash_message(clash),
        })
    });
    let errors: Vec<Value> = unreadable.chain(clashes).collect();

    json!({ "tickets": tickets, "errors": errors })
}

fn listing_text(listing: &TicketListing) -> String {
    let rows = listing
        .tickets
        .iter()
        .map(|ticket| read_row_text(ticket, &listing.derived));
    let errors = listing
        .errors
        .iter()
        .map(|error| format!("error: {}: {}", error.path.display(), error.message));
    let clashes = listing.clashes.iter().map(|clash| {
        format!(
            "error: {}: {}",
            clash_paths(clash).join("  "),
            clash_message(clash)
        )
    });

    let lines: Vec<String> = rows.chain(errors).chain(clashes).collect();

    if lines.is_empty() {
        return "No tickets.".to_owned();
    }

    lines.join("\n")
}

fn clash_paths(clash: &IdClash) -> Vec<String> {
    clash
        .paths
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

fn clash_message(clash: &IdClash) -> String {
    StoreError::IdShared {
        id: clash.id.to_string(),
        paths: clash.paths.clone(),
    }
    .to_string()
}
