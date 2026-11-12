use std::path::PathBuf;

use serde_json::json;
use tikk_core::{NewTicket, NewTicketSource, Store, StoreError, TicketEffects};

use crate::command::NewArguments;
use crate::output::Output;

pub(crate) fn run(
    store: &Store,
    arguments: NewArguments,
    working_directory: PathBuf,
    effects: &TicketEffects,
) -> Result<Output, StoreError> {
    let request = NewTicket {
        source: source(
            arguments.kind,
            arguments.title,
            arguments.file,
            arguments.parent,
        ),
        project: arguments.project,
        working_directory,
    };
    let created = tikk_core::create_ticket(store, request, effects)?;
    let id = created.id.to_string();

    Ok(Output {
        json: json!({ "id": id, "path": created.path.to_string_lossy() }),
        text: id,
    })
}

fn source(
    kind: Option<tikk_core::Kind>,
    title: Option<String>,
    file: Option<PathBuf>,
    parent: Option<tikk_core::TicketId>,
) -> NewTicketSource {
    match (file, kind, title) {
        (Some(path), _, _) => NewTicketSource::File(path),
        (None, Some(kind), Some(title)) => NewTicketSource::Fields {
            kind,
            title,
            parent,
        },
        _ => unreachable!("clap requires a kind and a title without --file"),
    }
}
