use std::ffi::OsStr;
use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt as _;
use std::path::{Path, PathBuf};

use tempfile::TempDir;

use crate::store::machine::MACHINE_FILE;
use crate::store::{CONFIG_FILE, MachineName, StoreEffects, StoreError, has_config};

const CONFIG: &str = "{\"version\":1}\n";
const ATTRIBUTES_FILE: &str = ".gitattributes";
const ATTRIBUTES: &str = "facts/** merge=union\n";
const FIRST_COMMIT: &[&str] = &[
    "-c",
    "user.name=tikk",
    "-c",
    "user.email=tikk@localhost",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "--message",
    "Create the tikk store",
];

#[derive(Debug, PartialEq, Eq)]
pub struct InitOutcome {
    pub store: PathBuf,
    pub created: bool,
}

// The staging folder is renamed onto the store path, and a rename cannot replace a symlink with a
// folder, so a link to an existing folder is replaced by that folder's path. A link to a missing
// target stays as given.
pub(crate) fn resolve_store_link(root: &Path) -> PathBuf {
    let is_link =
        fs::symlink_metadata(root).is_ok_and(|metadata| metadata.file_type().is_symlink());

    if !is_link {
        return root.to_path_buf();
    }

    fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf())
}

pub fn init(
    root: &Path,
    machine: Option<MachineName>,
    effects: &StoreEffects,
) -> Result<InitOutcome, StoreError> {
    let root = &resolve_store_link(root);

    if has_config(root)? {
        // A tikk.json without the store's own repository is not a store, so Git never runs there.
        ensure_own_repository(root, effects)?;

        let machine = choose_machine(root, machine, effects)?;

        return finish(root, machine, false);
    }

    if let Err(error) = ensure_empty(root) {
        return join_another_init(root, machine, effects, error);
    }

    let chosen = choose_machine(root, machine.clone(), effects)?;

    if create_store(root, effects)? {
        return finish(root, chosen, true);
    }

    let error = StoreError::FolderNotEmpty {
        store: root.to_path_buf(),
    };

    join_another_init(root, machine, effects, error)
}

fn join_another_init(
    root: &Path,
    machine: Option<MachineName>,
    effects: &StoreEffects,
    error: StoreError,
) -> Result<InitOutcome, StoreError> {
    if !has_config(root)? {
        return Err(error);
    }

    ensure_own_repository(root, effects)?;

    finish(root, machine, false)
}

fn finish(
    root: &Path,
    machine: Option<MachineName>,
    created: bool,
) -> Result<InitOutcome, StoreError> {
    if let Some(machine) = machine {
        write_file(&root.join(MACHINE_FILE), &format!("{machine}\n"))?;
    }

    Ok(InitOutcome {
        store: root.to_path_buf(),
        created,
    })
}

pub(crate) fn ensure_empty(root: &Path) -> Result<(), StoreError> {
    let mut entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(StoreError::Io {
                action: "read",
                path: root.to_path_buf(),
                source,
            });
        }
    };

    if entries.next().is_some() {
        return Err(StoreError::FolderNotEmpty {
            store: root.to_path_buf(),
        });
    }

    Ok(())
}

/// The store's `.git` must be a real folder that Git resolves to, and `main` must have the first
/// commit, which every store gets before it is renamed into place.
fn ensure_own_repository(root: &Path, effects: &StoreEffects) -> Result<(), StoreError> {
    let path = root.join(".git");
    let foreign = || StoreError::ForeignRepository {
        store: root.to_path_buf(),
    };
    let not_a_store = || StoreError::FolderNotEmpty {
        store: root.to_path_buf(),
    };
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(not_a_store()),
        Err(source) => {
            return Err(StoreError::Io {
                action: "check",
                path,
                source,
            });
        }
    };

    if !metadata.is_dir() {
        return Err(foreign());
    }

    let output =
        (effects.run_git)(root, &["rev-parse", "--absolute-git-dir"]).map_err(|_| foreign())?;
    let git_directory = output.strip_suffix(b"\n").unwrap_or(&output);
    let resolved = fs::canonicalize(OsStr::from_bytes(git_directory)).map_err(|_| foreign())?;
    let expected = fs::canonicalize(&path).map_err(|_| foreign())?;

    if resolved != expected {
        return Err(foreign());
    }

    (effects.run_git)(
        root,
        &["rev-parse", "--verify", "--quiet", "refs/heads/main"],
    )
    .map_err(|_| not_a_store())?;

    Ok(())
}

fn choose_machine(
    root: &Path,
    machine: Option<MachineName>,
    effects: &StoreEffects,
) -> Result<Option<MachineName>, StoreError> {
    if machine.is_some() {
        return Ok(machine);
    }

    let path = root.join(MACHINE_FILE);
    let saved = path.try_exists().map_err(|source| StoreError::Io {
        action: "check",
        path,
        source,
    })?;

    if saved {
        return Ok(None);
    }

    let host_name = (effects.read_host_name)()?;

    MachineName::from_host_name(&host_name).map(Some)
}

fn create_store(root: &Path, effects: &StoreEffects) -> Result<bool, StoreError> {
    let staging = create_staging(root)?;

    fill_new_store(staging.path(), effects.run_git)?;

    publish(staging, root)
}

/// A staging folder beside the store, removed when it is dropped before `publish`.
pub(crate) fn create_staging(root: &Path) -> Result<TempDir, StoreError> {
    let parent = root.parent().ok_or_else(|| StoreError::FolderNotEmpty {
        store: root.to_path_buf(),
    })?;
    let name = root.file_name().unwrap_or_default().to_string_lossy();

    fs::create_dir_all(parent).map_err(|source| StoreError::Io {
        action: "create",
        path: parent.to_path_buf(),
        source,
    })?;

    tempfile::Builder::new()
        .prefix(&format!(".{name}.tikk-init-"))
        .tempdir_in(parent)
        .map_err(|source| StoreError::Io {
            action: "create",
            path: parent.to_path_buf(),
            source,
        })
}

/// Gives the empty staging folder the files and the first commit of a new store.
pub(crate) fn fill_new_store(
    staging: &Path,
    run_git: fn(&Path, &[&str]) -> Result<Vec<u8>, StoreError>,
) -> Result<(), StoreError> {
    run_git(staging, &["init", "--quiet", "--initial-branch=main"])?;
    write_file(&staging.join(ATTRIBUTES_FILE), ATTRIBUTES)?;
    write_file(&staging.join(CONFIG_FILE), CONFIG)?;
    run_git(staging, &["add", "--", CONFIG_FILE, ATTRIBUTES_FILE])?;
    run_git(staging, FIRST_COMMIT)?;

    Ok(())
}

/// Renames the staging folder onto the store path. Returns false, and removes the staging folder,
/// when another `init` put a store there first.
pub(crate) fn publish(staging: TempDir, root: &Path) -> Result<bool, StoreError> {
    let staging = staging.keep();
    let Err(source) = fs::rename(&staging, root) else {
        return Ok(true);
    };

    fs::remove_dir_all(&staging).map_err(|error| StoreError::Io {
        action: "remove",
        path: staging.clone(),
        source: error,
    })?;

    if matches!(
        source.kind(),
        io::ErrorKind::DirectoryNotEmpty | io::ErrorKind::AlreadyExists
    ) {
        return Ok(false);
    }

    Err(StoreError::Io {
        action: "rename",
        path: root.to_path_buf(),
        source,
    })
}

pub(crate) fn write_file(path: &Path, contents: &str) -> Result<(), StoreError> {
    fs::write(path, contents).map_err(|source| StoreError::Io {
        action: "write",
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(test)]
#[path = "store_init_tests.rs"]
mod tests;
