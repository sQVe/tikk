use std::collections::HashMap;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use crate::store::system;
use crate::store::ticket_files::{
    StoredTicket, TICKETS_FOLDER, io_error, read_tickets, sha256_hex,
};
use crate::store::ticket_id_draw::draw_free_id;
use crate::store::{Store, StoreError};
use crate::ticket::{
    Kind, ProjectName, TicketDocument, TicketError, TicketFields, TicketId, ticket_file_name,
    write_document,
};

#[derive(Clone, Copy)]
pub struct TicketEffects {
    pub read_origin_url: fn(&Path) -> Result<Option<String>, StoreError>,
    pub fill_random: fn(&mut [u8]) -> Result<(), StoreError>,
}

impl TicketEffects {
    pub fn system() -> Self {
        Self {
            read_origin_url: system::read_origin_url,
            fill_random: system::fill_random,
        }
    }
}

#[derive(Debug, Clone)]
pub enum NewTicketSource {
    Fields {
        kind: Kind,
        title: String,
        parent: Option<TicketId>,
    },
    /// A ticket document at this path, in the form of a ticket file.
    File(PathBuf),
}

#[derive(Debug, Clone)]
pub struct NewTicket {
    pub source: NewTicketSource,
    pub project: Option<ProjectName>,
    /// The project comes from this folder's `origin` when neither a parent nor `project` sets it.
    pub working_directory: PathBuf,
}

/// Writes a new ticket file. It makes no commit.
pub fn create_ticket(
    store: &Store,
    request: NewTicket,
    effects: &TicketEffects,
) -> Result<StoredTicket, StoreError> {
    let document = read_source(request.source)?;
    let scan = read_tickets(store.root())?;
    let kinds: HashMap<&TicketId, Kind> = scan
        .tickets
        .iter()
        .map(|ticket| (&ticket.id, ticket.document.fields.kind()))
        .collect();

    document.fields.check_links(|id| kinds.get(id).copied())?;

    let project = choose_project(
        &document.fields,
        request.project,
        &request.working_directory,
        effects,
    )?;
    let folder = store.root().join(TICKETS_FOLDER).join(project.as_str());
    let id = draw_free_id(&project, &folder, effects)?;
    let path = folder.join(ticket_file_name(&id, document.fields.title()));
    let text = write_document(&document.fields, &document.body);

    write_new_file(&folder, &path, &text)?;

    Ok(StoredTicket {
        id,
        path,
        hash: sha256_hex(text.as_bytes()),
        document,
    })
}

fn read_source(source: NewTicketSource) -> Result<TicketDocument, StoreError> {
    match source {
        NewTicketSource::Fields {
            kind,
            title,
            parent,
        } => Ok(TicketDocument {
            fields: TicketFields::new(kind, &title, parent)?,
            body: String::new(),
        }),
        NewTicketSource::File(path) => {
            let text =
                fs::read_to_string(&path).map_err(|source| io_error("read", &path, source))?;

            Ok(TicketDocument::parse(&text)?)
        }
    }
}

/// A ticket with a parent is in the parent's project. Without one, `requested` wins over the
/// working directory's `origin`.
fn choose_project(
    fields: &TicketFields,
    requested: Option<ProjectName>,
    working_directory: &Path,
    effects: &TicketEffects,
) -> Result<ProjectName, StoreError> {
    if let Some(parent) = fields.parent() {
        let parent_project = parent.project();

        if let Some(requested) = requested.filter(|requested| requested != parent_project) {
            return Err(TicketError::invalid(
                "project",
                format!(
                    "is {requested}, but the parent {parent} is in the project {parent_project}"
                ),
            )
            .into());
        }

        return Ok(parent_project.clone());
    }

    if let Some(requested) = requested {
        return Ok(requested);
    }

    match (effects.read_origin_url)(working_directory)? {
        None => Ok(ProjectName::personal()),
        Some(url) => {
            ProjectName::from_origin_url(&url).map_err(|_| StoreError::InvalidOrigin { url })
        }
    }
}

fn write_new_file(folder: &Path, path: &Path, text: &str) -> Result<(), StoreError> {
    fs::create_dir_all(folder).map_err(|source| io_error("create", folder, source))?;

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|source| io_error("create", path, source))?;

    file.write_all(text.as_bytes())
        .map_err(|source| io_error("write", path, source))
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs;
    use std::path::{Path, PathBuf};

    use super::{NewTicket, NewTicketSource, TicketEffects, create_ticket};
    use crate::store::{Store, StoreError};
    use crate::ticket::{Kind, ProjectName, TicketError, TicketId};

    thread_local! {
        static DRAWS: Cell<u8> = const { Cell::new(0) };
    }

    fn no_origin(_: &Path) -> Result<Option<String>, StoreError> {
        Ok(None)
    }

    fn tikk_origin(_: &Path) -> Result<Option<String>, StoreError> {
        Ok(Some("git@github.com:owner/Tikk.git".to_owned()))
    }

    fn odd_origin(_: &Path) -> Result<Option<String>, StoreError> {
        Ok(Some("git@github.com:owner/my_app.git".to_owned()))
    }

    /// Each call fills the buffer with the next byte value: 0 gives `3333`, 1 gives `4444`.
    fn counting_random(buffer: &mut [u8]) -> Result<(), StoreError> {
        let value = DRAWS.with(|draws| {
            let value = draws.get();
            draws.set(value + 1);
            value
        });

        buffer.fill(value);

        Ok(())
    }

    fn effects(read_origin_url: fn(&Path) -> Result<Option<String>, StoreError>) -> TicketEffects {
        TicketEffects {
            read_origin_url,
            fill_random: counting_random,
        }
    }

    fn store(directory: &Path) -> Store {
        Store {
            root: directory.to_path_buf(),
        }
    }

    fn fields(kind: Kind, title: &str, parent: Option<&TicketId>) -> NewTicket {
        NewTicket {
            source: NewTicketSource::Fields {
                kind,
                title: title.to_owned(),
                parent: parent.cloned(),
            },
            project: None,
            working_directory: PathBuf::from("/work"),
        }
    }

    fn project(name: &str) -> ProjectName {
        ProjectName::parse(name).expect("a valid project name")
    }

    fn ticket_files(directory: &Path) -> Vec<String> {
        let mut names = Vec::new();

        for project in fs::read_dir(directory.join("tickets"))
            .into_iter()
            .flatten()
        {
            for entry in fs::read_dir(project.expect("an entry").path()).expect("a folder") {
                names.push(
                    entry
                        .expect("an entry")
                        .file_name()
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }

        names.sort();

        names
    }

    #[test]
    fn create_ticket_writes_the_file_in_the_origin_project() {
        DRAWS.set(0);
        let directory = tempfile::tempdir().expect("create a temporary directory");

        let created = create_ticket(
            &store(directory.path()),
            fields(Kind::Plan, "Move to tikk", None),
            &effects(tikk_origin),
        )
        .expect("the plan is created");

        assert_eq!(created.id.to_string(), "tikk-3333");
        assert_eq!(
            created.path,
            directory
                .path()
                .join("tickets/tikk/tikk-3333-move-to-tikk.md")
        );
        let text = fs::read_to_string(&created.path).expect("read the ticket file");
        assert_eq!(
            text,
            "---\nkind: plan\ntitle: Move to tikk\nstatus: open\n---\n"
        );
    }

    #[test]
    fn create_ticket_uses_personal_outside_a_repository_and_the_requested_project_over_origin() {
        let cases = [
            (no_origin as fn(&Path) -> _, None, "personal"),
            (tikk_origin, Some(project("other")), "other"),
        ];

        for (origin, requested, expected) in cases {
            DRAWS.set(0);
            let directory = tempfile::tempdir().expect("create a temporary directory");
            let request = NewTicket {
                project: requested,
                ..fields(Kind::Task, "Renew the domain", None)
            };

            let created = create_ticket(&store(directory.path()), request, &effects(origin))
                .expect("the task is created");

            assert_eq!(created.id.project().as_str(), expected, "case {expected}");
        }
    }

    #[test]
    fn create_ticket_takes_the_parent_project_and_refuses_another() {
        DRAWS.set(0);
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let request = NewTicket {
            project: Some(project("plans")),
            ..fields(Kind::Plan, "Move to tikk", None)
        };
        let plan = create_ticket(&store(directory.path()), request, &effects(tikk_origin))
            .expect("the plan is created");

        let slice = create_ticket(
            &store(directory.path()),
            fields(Kind::Slice, "Add files", Some(&plan.id)),
            &effects(tikk_origin),
        )
        .expect("the slice is created");
        let refused = create_ticket(
            &store(directory.path()),
            NewTicket {
                project: Some(project("tikk")),
                ..fields(Kind::Slice, "Add more", Some(&plan.id))
            },
            &effects(tikk_origin),
        )
        .expect_err("the project differs from the parent's");

        assert_eq!(slice.id.project().as_str(), "plans");
        assert!(
            matches!(&refused, StoreError::Ticket(TicketError::Invalid { field, .. }) if field == "project"),
            "{refused:?}"
        );
        assert_eq!(ticket_files(directory.path()).len(), 2);
    }

    #[test]
    fn create_ticket_refuses_a_task_under_a_slice_and_writes_nothing() {
        DRAWS.set(0);
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let plan = create_ticket(
            &store(directory.path()),
            fields(Kind::Plan, "Plan", None),
            &effects(no_origin),
        )
        .expect("the plan is created");
        let slice = create_ticket(
            &store(directory.path()),
            fields(Kind::Slice, "Slice", Some(&plan.id)),
            &effects(no_origin),
        )
        .expect("the slice is created");
        let document = directory.path().join("task.md");
        fs::write(
            &document,
            format!("---\nkind: task\ntitle: Task\nparent: {}\n---\n", slice.id),
        )
        .expect("write a document");
        let before = ticket_files(directory.path());

        let error = create_ticket(
            &store(directory.path()),
            NewTicket {
                source: NewTicketSource::File(document),
                ..fields(Kind::Task, "unused", None)
            },
            &effects(no_origin),
        )
        .expect_err("a task cannot sit under a slice");

        assert!(
            matches!(&error, StoreError::Ticket(TicketError::Invalid { field, .. }) if field == "parent"),
            "{error:?}"
        );
        assert_eq!(ticket_files(directory.path()), before);
    }

    #[test]
    fn create_ticket_refuses_an_origin_that_names_no_project() {
        let directory = tempfile::tempdir().expect("create a temporary directory");

        let error = create_ticket(
            &store(directory.path()),
            fields(Kind::Task, "Task", None),
            &effects(odd_origin),
        )
        .expect_err("my_app is not a project name");

        assert!(
            matches!(&error, StoreError::InvalidOrigin { url } if url.ends_with("my_app.git")),
            "{error:?}"
        );
    }

    #[test]
    fn create_ticket_reports_a_missing_document_file() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let missing = directory.path().join("missing.md");

        let error = create_ticket(
            &store(directory.path()),
            NewTicket {
                source: NewTicketSource::File(missing.clone()),
                ..fields(Kind::Task, "unused", None)
            },
            &effects(no_origin),
        )
        .expect_err("the document is missing");

        assert!(
            matches!(&error, StoreError::Io { action: "read", path, .. } if *path == missing),
            "{error:?}"
        );
    }
}
