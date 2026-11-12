use tikk_core::{Store, StoreError, TicketId, WriteEffects};

use crate::output::Output;
use crate::ticket_row::written_output;

pub(crate) fn run(
    store: &Store,
    id: &TicketId,
    reason: &str,
    effects: &WriteEffects,
) -> Result<Output, StoreError> {
    let canceled = tikk_core::cancel_ticket(store, id, reason, effects)?;

    Ok(written_output(&canceled))
}
