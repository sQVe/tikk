use std::fs;
use std::path::{Path, PathBuf};

use crate::store::store_lock::{self, LockAccess, StoreLock};
use crate::store::ticket_file_write::replace_ticket_file;
use crate::store::ticket_files::{StoredTicket, io_error, read_tickets, sha256_hex};
use crate::store::ticket_link_checks::check_ticket_links;
use crate::store::ticket_queries::find_ticket;
use crate::store::{Store, StoreError};
use crate::ticket::{TicketDocument, TicketError, TicketFields, TicketId, write_document};

#[derive(Clone, Copy)]
pub struct WriteEffects {
    pub lock_store: fn(&Path, LockAccess) -> Result<StoreLock, StoreError>,
    pub replace_file: fn(&Path, &str, &str) -> Result<(), StoreError>,
}

impl WriteEffects {
    pub fn system() -> Self {
        Self {
            lock_store: store_lock::lock_store,
            replace_file: replace_ticket_file,
        }
    }
}

#[derive(Debug, Clone)]
pub struct TicketWrite {
    pub id: TicketId,
    pub file: PathBuf,
    pub hash: String,
}

pub fn write_ticket(
    store: &Store,
    request: TicketWrite,
    effects: &WriteEffects,
) -> Result<StoredTicket, StoreError> {
    let text = fs::read_to_string(&request.file)
        .map_err(|source| io_error("read", &request.file, source))?;
    let document = TicketDocument::parse(&text)?;

    refuse_other_project(&request.id, &document.fields)?;

    let _lock = (effects.lock_store)(store.root(), LockAccess::Exclusive)?;
    let scan = read_tickets(store.root())?;
    let current = find_ticket(&scan, &request.id)?;

    if current.hash != request.hash {
        return Err(StoreError::ChangedOnDisk {
            path: current.path.clone(),
        });
    }

    check_ticket_links(&document.fields, &scan)?;

    replace_ticket(current, document, effects)
}

// The caller holds the exclusive lock.
pub(crate) fn replace_ticket(
    current: &StoredTicket,
    document: TicketDocument,
    effects: &WriteEffects,
) -> Result<StoredTicket, StoreError> {
    let text = write_document(&document.fields, &document.body);

    (effects.replace_file)(&current.path, &text, &current.hash)?;

    Ok(StoredTicket {
        id: current.id.clone(),
        path: current.path.clone(),
        hash: sha256_hex(text.as_bytes()),
        text,
        document,
    })
}

fn refuse_other_project(id: &TicketId, fields: &TicketFields) -> Result<(), StoreError> {
    let Some(parent) = fields.parent() else {
        return Ok(());
    };

    if parent.project() == id.project() {
        return Ok(());
    }

    Err(TicketError::invalid(
        "parent",
        format!(
            "names {parent} in the project {}, but {id} is in the project {}",
            parent.project(),
            id.project()
        ),
    )
    .into())
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs;
    use std::path::{Path, PathBuf};

    use tempfile::TempDir;

    use super::{TicketWrite, WriteEffects, write_ticket};
    use crate::store::store_lock::{LockAccess, StoreLock};
    use crate::store::ticket_files::sha256_hex;
    use crate::store::{Store, StoreError};
    use crate::ticket::{TicketError, TicketId};

    const TASK: &str = "---\nkind: task\ntitle: Renew the domain\n---\n";

    thread_local! {
        static LOCKED_WITH: Cell<Option<LockAccess>> = const { Cell::new(None) };
    }

    fn busy_lock(_: &Path, access: LockAccess) -> Result<StoreLock, StoreError> {
        LOCKED_WITH.with(|locked| locked.set(Some(access)));

        Err(StoreError::Locked {
            lock: PathBuf::from("tikk.lock"),
        })
    }

    fn store_with_task() -> (TempDir, Store, PathBuf) {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let folder = directory.path().join("tickets/personal");
        let path = folder.join("personal-abcd-renew.md");
        fs::create_dir_all(directory.path().join(".git")).expect("create the Git folder");
        fs::create_dir_all(&folder).expect("create the project folder");
        fs::write(&path, TASK).expect("write the task");
        let store = Store {
            root: directory.path().to_path_buf(),
        };

        (directory, store, path)
    }

    fn request(directory: &TempDir, text: &str) -> TicketWrite {
        let file = directory.path().join("document.md");
        fs::write(&file, text).expect("write the document");

        TicketWrite {
            id: TicketId::parse("personal-abcd").expect("a valid ID"),
            file,
            hash: sha256_hex(TASK.as_bytes()),
        }
    }

    #[test]
    fn write_waits_for_the_exclusive_lock_and_writes_nothing_without_it() {
        let (directory, store, path) = store_with_task();
        let effects = WriteEffects {
            lock_store: busy_lock,
            ..WriteEffects::system()
        };

        let error = write_ticket(&store, request(&directory, TASK), &effects)
            .expect_err("the lock is held");

        assert!(matches!(error, StoreError::Locked { .. }), "{error:?}");
        assert_eq!(LOCKED_WITH.with(Cell::get), Some(LockAccess::Exclusive));
        assert_eq!(fs::read_to_string(&path).expect("read the task"), TASK);
    }

    #[test]
    fn write_refuses_a_parent_in_another_project() {
        let (directory, store, path) = store_with_task();
        let document = "---\nkind: task\ntitle: Renew the domain\nparent: tikk-wxyz\n---\n";

        let error = write_ticket(
            &store,
            request(&directory, document),
            &WriteEffects::system(),
        )
        .expect_err("the parent is in another project");

        assert!(
            matches!(
                &error,
                StoreError::Ticket(TicketError::Invalid { field, problem })
                    if field == "parent" && problem.contains("project tikk")
            ),
            "{error:?}"
        );
        assert_eq!(fs::read_to_string(&path).expect("read the task"), TASK);
    }

    #[test]
    fn write_returns_the_written_text_and_its_hash() {
        let (directory, store, path) = store_with_task();
        let document = "---\ntitle: Renew it\nkind: task\n---\nBody\n";
        let expected = "---\nkind: task\ntitle: Renew it\nstatus: open\n---\nBody\n";

        let written = write_ticket(
            &store,
            request(&directory, document),
            &WriteEffects::system(),
        )
        .expect("the hash matches");

        assert_eq!(written.text, expected);
        assert_eq!(written.hash, sha256_hex(expected.as_bytes()));
        assert_eq!(written.path, path);
        assert_eq!(fs::read_to_string(&path).expect("read the task"), expected);
    }
}
