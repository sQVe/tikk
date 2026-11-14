use std::path::Path;

use serde_json::json;
use tikk_core::{MachineName, StoreEffects, StoreError};

use crate::output::Output;

pub(crate) fn run(
    store: &Path,
    machine: Option<MachineName>,
    effects: &StoreEffects,
) -> Result<Output, StoreError> {
    let outcome = tikk_core::init(store, machine, effects)?;
    let path = outcome.store.to_string_lossy();
    let text = if outcome.created {
        format!("Created the tikk store at {path}.")
    } else {
        format!("The tikk store already exists at {path}.")
    };

    Ok(Output {
        json: json!({ "store": path, "created": outcome.created }),
        text,
    })
}
