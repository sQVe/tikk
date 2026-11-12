use std::collections::HashMap;

use crate::store::StoreError;
use crate::store::ticket_files::TicketScan;
use crate::store::ticket_queries::ticket_path;
use crate::ticket::{Kind, TicketFields, TicketId};

pub(crate) fn check_ticket_links(
    fields: &TicketFields,
    scan: &TicketScan,
) -> Result<(), StoreError> {
    for id in fields.linked_ids() {
        if let Err(error @ StoreError::IdShared { .. }) = ticket_path(scan, id) {
            return Err(error);
        }
    }

    let kinds: HashMap<&TicketId, Kind> = scan
        .tickets
        .iter()
        .map(|ticket| (&ticket.id, ticket.document.fields.kind()))
        .collect();

    fields.check_links(|id| kinds.get(id).copied())?;

    Ok(())
}
