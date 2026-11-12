use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::store::{CONFIG_FILE, MachineName, StoreEffects, StoreError, has_config};

const CONFIG: &str = "{\"version\":1}\n";
const ATTRIBUTES_FILE: &str = ".gitattributes";
const ATTRIBUTES: &str = "facts/** merge=union\n";
const MACHINE_FILE: &str = ".git/tikk-machine";
const FIRST_COMMIT: &[&str] = &[
    "-c",
    "user.name=tikk",
    "-c",
    "user.email=tikk@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--no-verify",
    "--message",
    "Create the tikk store",
];

#[derive(Debug, PartialEq, Eq)]
pub struct InitOutcome {
    pub store: PathBuf,
    pub created: bool,
}

pub fn init(
    root: &Path,
    machine: Option<MachineName>,
    effects: &StoreEffects,
) -> Result<InitOutcome, StoreError> {
    let created = !has_config(root)?;

    if created {
        ensure_no_files(root)?;
    }

    let machine = choose_machine(root, machine, effects)?;

    if created {
        create_store(root, effects)?;
    }

    if let Some(machine) = machine {
        write_file(&root.join(MACHINE_FILE), &format!("{machine}\n"))?;
    }

    Ok(InitOutcome {
        store: root.to_path_buf(),
        created,
    })
}

fn ensure_no_files(root: &Path) -> Result<(), StoreError> {
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

fn create_store(root: &Path, effects: &StoreEffects) -> Result<(), StoreError> {
    fs::create_dir_all(root).map_err(|source| StoreError::Io {
        action: "create",
        path: root.to_path_buf(),
        source,
    })?;
    (effects.run_git)(root, &["init", "--quiet", "--initial-branch=main"])?;
    write_file(&root.join(ATTRIBUTES_FILE), ATTRIBUTES)?;
    // tikk.json marks a store, so it is written after the other files.
    write_file(&root.join(CONFIG_FILE), CONFIG)?;
    (effects.run_git)(root, &["add", "--", CONFIG_FILE, ATTRIBUTES_FILE])?;
    (effects.run_git)(root, FIRST_COMMIT)
}

fn write_file(path: &Path, contents: &str) -> Result<(), StoreError> {
    fs::write(path, contents).map_err(|source| StoreError::Io {
        action: "write",
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    use tempfile::TempDir;

    use super::{InitOutcome, init};
    use crate::store::{MachineName, StoreEffects, StoreError};

    fn temporary_directory() -> TempDir {
        tempfile::Builder::new()
            .prefix("tikk-core-test-")
            .tempdir()
            .expect("create a temporary directory")
    }

    fn effects_with_host(read_host_name: fn() -> Result<String, StoreError>) -> StoreEffects {
        StoreEffects {
            read_host_name,
            ..StoreEffects::system()
        }
    }

    fn laptop_host() -> Result<String, StoreError> {
        Ok("Laptop.example.com\n".to_owned())
    }

    fn missing_host() -> Result<String, StoreError> {
        Err(StoreError::HostNameUnavailable {
            message: "no host name in this test".to_owned(),
        })
    }

    fn underscore_host() -> Result<String, StoreError> {
        Ok("my_host\n".to_owned())
    }

    fn machine_file(root: &Path) -> String {
        fs::read_to_string(root.join(".git/tikk-machine")).expect("read the machine file")
    }

    fn commit_count(root: &Path) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["rev-list", "--count", "main"])
            .env_remove("GIT_DIR")
            .env_remove("GIT_INDEX_FILE")
            .output()
            .expect("start git");

        String::from_utf8(output.stdout)
            .expect("git prints UTF-8")
            .trim()
            .to_owned()
    }

    #[test]
    fn init_creates_the_layout_and_one_commit() {
        let directory = temporary_directory();
        let root = directory.path().join("store");

        let outcome = init(&root, None, &effects_with_host(laptop_host)).expect("init succeeds");

        assert_eq!(
            outcome,
            InitOutcome {
                store: root.clone(),
                created: true
            }
        );
        assert_eq!(
            fs::read_to_string(root.join("tikk.json")).expect("read tikk.json"),
            "{\"version\":1}\n"
        );
        assert_eq!(
            fs::read_to_string(root.join(".gitattributes")).expect("read .gitattributes"),
            "facts/** merge=union\n"
        );
        assert_eq!(machine_file(&root), "laptop\n");
        assert_eq!(commit_count(&root), "1");
    }

    #[test]
    fn init_on_an_existing_store_changes_nothing_but_a_given_machine() {
        let directory = temporary_directory();
        let root = directory.path().join("store");
        init(&root, None, &effects_with_host(laptop_host)).expect("first init succeeds");

        let unchanged = init(&root, None, &effects_with_host(missing_host))
            .expect("a saved machine needs no host name");
        let renamed = init(
            &root,
            Some(MachineName::parse("desk").expect("a valid name")),
            &effects_with_host(missing_host),
        )
        .expect("a given machine needs no host name");

        assert!(!unchanged.created);
        assert!(!renamed.created);
        assert_eq!(machine_file(&root), "desk\n");
        assert_eq!(commit_count(&root), "1");
    }

    #[test]
    fn init_refuses_a_folder_with_other_files_and_writes_nothing() {
        let directory = temporary_directory();
        let root = directory.path().to_path_buf();
        fs::write(root.join("notes.txt"), "mine").expect("write a file");

        let error = init(&root, None, &effects_with_host(laptop_host))
            .expect_err("a folder with files is refused");

        assert!(
            matches!(&error, StoreError::FolderNotEmpty { store } if *store == root),
            "{error:?}"
        );
        let names: Vec<_> = fs::read_dir(&root)
            .expect("read the folder")
            .map(|entry| entry.expect("read an entry").file_name())
            .collect();
        assert_eq!(names, vec![OsString::from("notes.txt")]);
    }

    #[test]
    fn init_accepts_an_empty_folder() {
        let directory = temporary_directory();

        let outcome = init(directory.path(), None, &effects_with_host(laptop_host))
            .expect("an empty folder becomes a store");

        assert!(outcome.created);
    }

    #[test]
    fn init_reports_a_folder_it_cannot_read() {
        use std::os::unix::fs::PermissionsExt as _;

        let directory = temporary_directory();
        let root = directory.path().join("store");
        fs::create_dir(&root).expect("create the store folder");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o300))
            .expect("remove read permission");

        let result = init(&root, None, &effects_with_host(laptop_host));

        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .expect("restore read permission");
        let error = result.expect_err("an unreadable folder is refused");
        assert!(
            matches!(
                &error,
                StoreError::Io { action: "read", path, source }
                    if *path == root && source.kind() == std::io::ErrorKind::PermissionDenied
            ),
            "{error:?}"
        );
        assert!(!root.join(".git").exists());
    }

    #[test]
    fn init_with_an_invalid_host_name_creates_nothing() {
        let directory = temporary_directory();
        let root = directory.path().join("store");

        let error = init(&root, None, &effects_with_host(underscore_host))
            .expect_err("the host name gives no machine name");

        assert!(
            matches!(&error, StoreError::InvalidHostName { host_name } if host_name == "my_host"),
            "{error:?}"
        );
        assert!(!root.exists());
    }
}
