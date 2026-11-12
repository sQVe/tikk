mod machine;
mod store_init;
mod system;

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

use thiserror::Error;

pub use machine::MachineName;
pub use store_init::{InitOutcome, init};

const CONFIG_FILE: &str = "tikk.json";
const STORE_UNDER_HOME: &str = ".local/share/tikk";

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("No tikk store at {}. Run `tikk init` first.", store.display())]
    NotInitialized { store: PathBuf },
    #[error("{} holds files but no tikk store.", store.display())]
    FolderNotEmpty { store: PathBuf },
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
    #[error("Could not {action} {}: {source}", path.display())]
    Io {
        action: &'static str,
        path: PathBuf,
        source: io::Error,
    },
}

/// The effects the store runs. `system` builds the real ones.
#[derive(Clone, Copy)]
pub struct StoreEffects {
    /// Runs Git in a folder with an argument list.
    pub run_git: fn(&Path, &[&str]) -> Result<(), StoreError>,
    /// Returns the host name as the system prints it, with any domain and line end.
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

/// Returns `$TIKK_HOME`, or `~/.local/share/tikk` when it is unset or empty.
pub fn store_path(
    tikk_home: Option<OsString>,
    home: Option<OsString>,
) -> Result<PathBuf, StoreError> {
    if let Some(tikk_home) = tikk_home.filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(tikk_home));
    }

    let home = home
        .filter(|value| !value.is_empty())
        .ok_or(StoreError::NoStorePath)?;

    Ok(PathBuf::from(home).join(STORE_UNDER_HOME))
}

/// Opens an existing store. Every command that reads or writes the store starts here.
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

fn has_config(root: &Path) -> Result<bool, StoreError> {
    let path = root.join(CONFIG_FILE);

    path.try_exists().map_err(|source| StoreError::Io {
        action: "check",
        path,
        source,
    })
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
