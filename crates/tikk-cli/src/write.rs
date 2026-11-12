use tikk_core::{Store, StoreError, TicketWrite, WriteEffects};

use crate::output::Output;
use crate::ticket_row::written_output;

pub(crate) fn run(
    store: &Store,
    request: TicketWrite,
    effects: &WriteEffects,
) -> Result<Output, StoreError> {
    let written = tikk_core::write_ticket(store, request, effects)?;

    Ok(written_output(&written))
}
