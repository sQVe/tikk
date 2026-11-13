use std::path::Path;

use serde_json::json;
use tikk_core::{InitOutcome, MachineName, RemoteInitEffects, StoreEffects, StoreError};

use crate::output::Output;

pub(crate) fn run(
    store: &Path,
    machine: Option<MachineName>,
    effects: &StoreEffects,
) -> Result<Output, StoreError> {
    tikk_core::init(store, machine, effects).map(|outcome| init_output(&outcome))
}

pub(crate) fn run_remote(
    store: &Path,
    url: &str,
    machine: Option<MachineName>,
    effects: &RemoteInitEffects,
) -> Result<Output, StoreError> {
    tikk_core::init_from_remote(store, url, machine, effects).map(|outcome| init_output(&outcome))
}

fn init_output(outcome: &InitOutcome) -> Output {
    let path = outcome.store.to_string_lossy();
    let text = if outcome.created {
        format!("Created the tikk store at {path}.")
    } else {
        format!("The tikk store already exists at {path}.")
    };

    Output {
        json: json!({ "store": path, "created": outcome.created }),
        text,
    }
}
