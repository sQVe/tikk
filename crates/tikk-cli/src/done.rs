use tikk_core::{Store, StoreError, TicketId, WriteEffects};

use crate::output::Output;
use crate::ticket_row::written_output;

pub(crate) fn run(
    store: &Store,
    id: &TicketId,
    effects: &WriteEffects,
) -> Result<Output, StoreError> {
    let done = tikk_core::mark_done(store, id, effects)?;

    Ok(written_output(&done))
}
