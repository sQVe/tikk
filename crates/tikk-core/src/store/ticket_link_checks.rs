use std::collections::{HashMap, HashSet};

use crate::store::StoreError;
use crate::store::ticket_files::TicketScan;
use crate::store::ticket_queries::ticket_path;
use crate::ticket::{Kind, TicketError, TicketFields, TicketId};

pub(crate) fn check_ticket_links(
    fields: &TicketFields,
    scan: &TicketScan,
) -> Result<(), StoreError> {
    check_links_with(fields, scan, None)
}

// The scan holds the ticket as it was, so the ticket's new kind and parent replace its old ones.
pub(crate) fn check_written_links(
    id: &TicketId,
    fields: &TicketFields,
    scan: &TicketScan,
) -> Result<(), StoreError> {
    refuse_parent_cycle(id, fields, scan)?;
    check_links_with(fields, scan, Some(id))?;

    let children = scan
        .tickets
        .iter()
        .filter(|ticket| ticket.id != *id && ticket.document.fields.parent() == Some(id));

    for child in children {
        fields.check_child(&child.id, child.document.fields.kind())?;
    }

    Ok(())
}

fn check_links_with(
    fields: &TicketFields,
    scan: &TicketScan,
    written: Option<&TicketId>,
) -> Result<(), StoreError> {
    for id in fields.linked_ids() {
        if let Err(error @ StoreError::IdShared { .. }) = ticket_path(scan, id) {
            return Err(error);
        }
    }

    let mut kinds: HashMap<&TicketId, Kind> = scan
        .tickets
        .iter()
        .map(|ticket| (&ticket.id, ticket.document.fields.kind()))
        .collect();

    if let Some(id) = written {
        kinds.insert(id, fields.kind());
    }

    fields.check_links(|id| kinds.get(id).copied())?;

    Ok(())
}

fn refuse_parent_cycle(
    id: &TicketId,
    fields: &TicketFields,
    scan: &TicketScan,
) -> Result<(), StoreError> {
    let Some(parent) = fields.parent() else {
        return Ok(());
    };
    let parents: HashMap<&TicketId, &TicketId> = scan
        .tickets
        .iter()
        .filter_map(|ticket| {
            ticket
                .document
                .fields
                .parent()
                .map(|parent| (&ticket.id, parent))
        })
        .collect();
    let mut seen = HashSet::new();
    let mut next = Some(parent);

    while let Some(ancestor) = next {
        if ancestor == id {
            return Err(TicketError::invalid(
                "parent",
                format!("names {parent}, which makes a cycle back to {id}"),
            )
            .into());
        }

        if !seen.insert(ancestor) {
            return Ok(());
        }

        next = parents.get(ancestor).copied();
    }

    Ok(())
}
