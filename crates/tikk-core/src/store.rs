mod machine;
mod store_init;
mod store_lock;
mod system;
mod ticket_create;
mod ticket_edit;
mod ticket_file_write;
mod ticket_files;
mod ticket_id_draw;
mod ticket_link_checks;
mod ticket_new_file;
mod ticket_queries;
mod ticket_status;
mod ticket_write;

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use thiserror::Error;

pub use machine::MachineName;
pub use store_init::{InitOutcome, init};
pub use store_lock::{LockAccess, StoreLock};
pub use ticket_create::{NewTicket, NewTicketSource, TicketEffects, create_ticket};
pub use ticket_edit::{EditEffects, edit_ticket};
pub use ticket_files::{StoredTicket, UnreadableTicket};
pub use ticket_queries::{
    QueryEffects, ShownTicket, TicketFilter, TicketListing, list_tickets, show_ticket,
};
pub use ticket_status::{cancel_ticket, mark_done};
pub use ticket_write::{TicketWrite, WriteEffects, write_ticket};

use crate::ticket::{Kind, TicketError};

const CONFIG_FILE: &str = "tikk.json";
const STORE_UNDER_HOME: &str = ".local/share/tikk";

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("No tikk store at {}. Run `tikk init` first.", store.display())]
    NotInitialized { store: PathBuf },
    #[error("{} holds files but no tikk store.", store.display())]
    FolderNotEmpty { store: PathBuf },
    #[error("{} is not a tikk config with version 1.", path.display())]
    InvalidConfig { path: PathBuf },
    #[error("{}/.git is not the store's own Git repository.", store.display())]
    ForeignRepository { store: PathBuf },
    #[error("Neither TIKK_HOME nor HOME is set, so the store has no path.")]
    NoStorePath,
    #[error("`{name}` is not a machine name: {reason}.")]
    InvalidMachineName { name: String, reason: &'static str },
    #[error("The host name `{host_name}` gives no machine name. Pass --machine.")]
    InvalidHostName { host_name: String },
    #[error("Could not read the host name: {message}. Pass --machine.")]
    HostNameUnavailable { message: String },
    #[error("`git {arguments}` failed: {message}")]
    Git { arguments: String, message: String },
    #[error(transparent)]
    Ticket(#[from] TicketError),
    #[error("{} is not a valid ticket file: {message}", path.display())]
    TicketParse { path: PathBuf, message: String },
    #[error("No ticket has the ID {id}.")]
    NotFound { id: String },
    #[error("{} files share the ID {id}. Rename all but one.", paths.len())]
    IdShared { id: String, paths: Vec<PathBuf> },
    #[error("The repository name in the origin URL `{url}` is not a project name. Pass --project.")]
    InvalidOrigin { url: String },
    #[error("Found no free ID in the project {project}.")]
    NoFreeId { project: String },
    #[error("Could not read random bytes: {message}")]
    RandomUnavailable { message: String },
    #[error("Another process held the store lock {} for too long. Try again.", lock.display())]
    Locked { lock: PathBuf },
    #[error("{} changed after it was read. Run `tikk show` again and redo the change.", path.display())]
    ChangedOnDisk { path: PathBuf },
    #[error("{id} is a {kind}, but this command takes {allowed}.")]
    WrongKind {
        id: String,
        kind: Kind,
        allowed: &'static str,
    },
    #[error("EDITOR is not set. Set it to the editor to start, such as `EDITOR=vi`.")]
    NoEditor,
    #[error("The editor failed: {message}")]
    EditorFailed { message: String },
    #[error("Could not {action} {}: {source}", path.display())]
    Io {
        action: &'static str,
        path: PathBuf,
        source: io::Error,
    },
}

#[derive(Clone, Copy)]
pub struct StoreEffects {
    pub run_git: fn(&Path, &[&str]) -> Result<String, StoreError>,
    pub read_host_name: fn() -> Result<String, StoreError>,
}

impl StoreEffects {
    pub fn system() -> Self {
        Self {
            run_git: system::run_git,
            read_host_name: system::read_host_name,
        }
    }
}

#[derive(Debug)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn root(&self) -> &Path {
        &self.root
    }
}

pub fn store_path(
    tikk_home: Option<OsString>,
    home: Option<OsString>,
) -> Result<PathBuf, StoreError> {
    if let Some(tikk_home) = tikk_home.filter(|value| !value.is_empty()) {
        return absolute(PathBuf::from(tikk_home));
    }

    let home = home
        .filter(|value| !value.is_empty())
        .ok_or(StoreError::NoStorePath)?;

    absolute(PathBuf::from(home).join(STORE_UNDER_HOME))
}

/// Git ignores a relative `GIT_CEILING_DIRECTORIES`, so every store path is absolute.
fn absolute(path: PathBuf) -> Result<PathBuf, StoreError> {
    std::path::absolute(&path).map_err(|source| StoreError::Io {
        action: "resolve",
        path,
        source,
    })
}

pub fn open(root: &Path) -> Result<Store, StoreError> {
    if !has_config(root)? {
        return Err(StoreError::NotInitialized {
            store: root.to_path_buf(),
        });
    }

    Ok(Store {
        root: root.to_path_buf(),
    })
}

/// Returns whether the folder holds `tikk.json`, and refuses one that is not version 1.
fn has_config(root: &Path) -> Result<bool, StoreError> {
    let path = root.join(CONFIG_FILE);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(source) => {
            return Err(StoreError::Io {
                action: "read",
                path,
                source,
            });
        }
    };
    let config: Option<serde_json::Value> = serde_json::from_str(&text).ok();

    if config != Some(serde_json::json!({ "version": 1 })) {
        return Err(StoreError::InvalidConfig { path });
    }

    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::fs;
    use std::path::PathBuf;

    use super::{StoreError, open, store_path};

    #[test]
    fn open_reports_not_initialized_for_a_missing_store() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let root = directory.path().join("store");

        let error = open(&root).expect_err("no store exists");

        assert!(
            matches!(&error, StoreError::NotInitialized { store } if *store == root),
            "{error:?}"
        );
    }

    #[test]
    fn open_finds_a_folder_with_tikk_json() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        fs::write(directory.path().join("tikk.json"), "{\"version\":1}\n")
            .expect("write tikk.json");

        let store = open(directory.path()).expect("the store opens");

        assert_eq!(store.root(), directory.path());
    }

    #[test]
    fn store_path_makes_a_relative_tikk_home_absolute() {
        let path = store_path(Some(OsString::from("candidate")), None).expect("a path is found");

        assert_eq!(
            path,
            std::env::current_dir()
                .expect("read the current folder")
                .join("candidate")
        );
    }

    #[test]
    fn store_path_prefers_tikk_home_then_home() {
        let cases = [
            (Some("/data/tikk"), Some("/home/user"), "/data/tikk"),
            (None, Some("/home/user"), "/home/user/.local/share/tikk"),
            (Some(""), Some("/home/user"), "/home/user/.local/share/tikk"),
        ];

        for (tikk_home, home, expected) in cases {
            let path = store_path(tikk_home.map(OsString::from), home.map(OsString::from))
                .expect("a path is found");

            assert_eq!(
                path,
                PathBuf::from(expected),
                "case {tikk_home:?}, {home:?}"
            );
        }
    }

    #[test]
    fn store_path_needs_tikk_home_or_home() {
        for home in [None, Some(OsString::new())] {
            let error = store_path(None, home.clone()).expect_err("no path can be found");

            assert!(
                matches!(error, StoreError::NoStorePath),
                "case {home:?}: {error:?}"
            );
        }
    }
}
