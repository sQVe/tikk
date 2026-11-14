use std::ffi::OsStr;

use serde_json::json;
use tikk_core::{EditEffects, Store, StoreError, TicketId};

use crate::output::Output;

pub(crate) fn run(
    store: &Store,
    id: &TicketId,
    editor: Option<&OsStr>,
    effects: &EditEffects,
) -> Result<Output, StoreError> {
    let path = tikk_core::edit_ticket(store, id, editor, effects)?;
    let path = path.to_string_lossy();

    Ok(Output {
        json: json!({ "id": id.to_string(), "path": path }),
        text: path.into_owned(),
    })
}
