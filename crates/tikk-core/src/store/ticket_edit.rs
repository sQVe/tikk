use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::store::store_lock::{self, LockAccess, StoreLock};
use crate::store::system;
use crate::store::ticket_files::read_tickets;
use crate::store::ticket_queries::ticket_path;
use crate::store::{Store, StoreError};
use crate::ticket::TicketId;

#[derive(Clone, Copy)]
pub struct EditEffects {
    pub lock_store: fn(&Path, LockAccess) -> Result<StoreLock, StoreError>,
    pub start_editor: fn(&OsStr, &Path) -> Result<(), StoreError>,
}

impl EditEffects {
    pub fn system() -> Self {
        Self {
            lock_store: store_lock::lock_store,
            start_editor: system::start_editor,
        }
    }
}

/// Starts the editor on the ticket file and returns its path. It opens a file that does not
/// parse, so the user can repair it, and holds no lock while the editor runs.
pub fn edit_ticket(
    store: &Store,
    id: &TicketId,
    editor: Option<&OsStr>,
    effects: &EditEffects,
) -> Result<PathBuf, StoreError> {
    let editor = editor
        .filter(|editor| !editor.is_empty())
        .ok_or(StoreError::NoEditor)?;
    let path = {
        let _lock = (effects.lock_store)(store.root(), LockAccess::Shared)?;
        let scan = read_tickets(store.root())?;

        ticket_path(&scan, id)?.to_path_buf()
    };

    (effects.start_editor)(editor, &path)?;

    Ok(path)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::ffi::OsStr;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use tempfile::TempDir;

    use super::{EditEffects, edit_ticket};
    use crate::store::store_lock::{LockAccess, lock_store_within};
    use crate::store::{Store, StoreError};
    use crate::ticket::TicketId;

    thread_local! {
        static EDITED: RefCell<Option<(PathBuf, bool)>> = const { RefCell::new(None) };
    }

    // Records the path, and whether a writer could take the lock while the editor ran.
    fn recording_editor(_: &OsStr, path: &Path) -> Result<(), StoreError> {
        let root = path
            .ancestors()
            .nth(3)
            .expect("the file is in tickets/<project>/");
        let free = lock_store_within(root, LockAccess::Exclusive, Duration::ZERO).is_ok();

        EDITED.with(|edited| edited.replace(Some((path.to_path_buf(), free))));

        Ok(())
    }

    fn store_with(files: &[(&str, &str)]) -> (TempDir, Store) {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let folder = directory.path().join("tickets/personal");
        fs::create_dir_all(directory.path().join(".git")).expect("create the Git folder");
        fs::create_dir_all(&folder).expect("create the project folder");

        for (name, text) in files {
            fs::write(folder.join(name), text).expect("write a ticket");
        }

        let store = Store {
            root: directory.path().to_path_buf(),
        };

        (directory, store)
    }

    fn effects() -> EditEffects {
        EditEffects {
            start_editor: recording_editor,
            ..EditEffects::system()
        }
    }

    fn id() -> TicketId {
        TicketId::parse("personal-abcd").expect("a valid ID")
    }

    #[test]
    fn edit_starts_the_editor_on_the_file_without_holding_the_lock() {
        let (directory, store) = store_with(&[("personal-abcd-renew.md", "kind: [\n")]);

        let path = edit_ticket(&store, &id(), Some(OsStr::new("vi")), &effects())
            .expect("a broken file can be edited");

        let expected = directory
            .path()
            .join("tickets/personal/personal-abcd-renew.md");
        assert_eq!(path, expected);
        assert_eq!(EDITED.with(|edited| edited.take()), Some((expected, true)));
    }

    #[test]
    fn edit_refuses_a_missing_editor_and_a_shared_id_without_starting_one() {
        let (_directory, store) = store_with(&[
            ("personal-abcd-renew.md", "---\nkind: task\ntitle: A\n---\n"),
            ("personal-abcd-copy.md", "---\nkind: task\ntitle: B\n---\n"),
        ]);

        let unset = edit_ticket(&store, &id(), None, &effects());
        let empty = edit_ticket(&store, &id(), Some(OsStr::new("")), &effects());
        let shared = edit_ticket(&store, &id(), Some(OsStr::new("vi")), &effects());

        assert!(matches!(unset, Err(StoreError::NoEditor)), "{unset:?}");
        assert!(matches!(empty, Err(StoreError::NoEditor)), "{empty:?}");
        assert!(
            matches!(&shared, Err(StoreError::IdShared { paths, .. }) if paths.len() == 2),
            "{shared:?}"
        );
        assert_eq!(EDITED.with(|edited| edited.take()), None);
    }
}
