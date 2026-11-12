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
    // A tikk.json without the store's own repository is not a store, so Git never runs there.
    let has_config = has_config(root)? && has_repository(root)?;

    if !has_config {
        ensure_no_files(root)?;
    }

    let machine = choose_machine(root, machine, effects)?;

    if !has_config {
        create_store_files(root, effects)?;
    }

    let created = !has_config || !has_first_commit(root, effects);

    if created {
        commit_store_files(root, effects)?;
    }

    if let Some(machine) = machine {
        write_file(&root.join(MACHINE_FILE), &format!("{machine}\n"))?;
    }

    Ok(InitOutcome {
        store: root.to_path_buf(),
        created,
    })
}

fn has_repository(root: &Path) -> Result<bool, StoreError> {
    let path = root.join(".git");

    path.try_exists().map_err(|source| StoreError::Io {
        action: "check",
        path,
        source,
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

/// A failed first commit leaves `tikk.json` with no commit, and the next `init` finishes the store.
/// Any rev-parse failure counts as no commit; the `git add` that follows reports a Git that cannot run.
fn has_first_commit(root: &Path, effects: &StoreEffects) -> bool {
    (effects.run_git)(
        root,
        &["rev-parse", "--verify", "--quiet", "refs/heads/main"],
    )
    .is_ok()
}

fn create_store_files(root: &Path, effects: &StoreEffects) -> Result<(), StoreError> {
    fs::create_dir_all(root).map_err(|source| StoreError::Io {
        action: "create",
        path: root.to_path_buf(),
        source,
    })?;
    (effects.run_git)(root, &["init", "--quiet", "--initial-branch=main"])?;
    write_file(&root.join(ATTRIBUTES_FILE), ATTRIBUTES)?;
    // tikk.json marks a store, so it is written after the other files.
    write_file(&root.join(CONFIG_FILE), CONFIG)
}

fn commit_store_files(root: &Path, effects: &StoreEffects) -> Result<(), StoreError> {
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

    fn git_output(root: &Path, arguments: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(arguments)
            .env_remove("GIT_DIR")
            .env_remove("GIT_INDEX_FILE")
            .output()
            .expect("start git");

        String::from_utf8(output.stdout)
            .expect("git prints UTF-8")
            .trim()
            .to_owned()
    }

    fn commit_count(root: &Path) -> String {
        git_output(root, &["rev-list", "--count", "main"])
    }

    fn git_without_commit(directory: &Path, arguments: &[&str]) -> Result<(), StoreError> {
        if arguments.contains(&"commit") {
            return Err(StoreError::Git {
                arguments: arguments.join(" "),
                message: "the commit fails in this test".to_owned(),
            });
        }

        (StoreEffects::system().run_git)(directory, arguments)
    }

    #[test]
    fn init_after_a_failed_first_commit_finishes_the_store() {
        let directory = temporary_directory();
        let root = directory.path().join("store");
        let failing = StoreEffects {
            run_git: git_without_commit,
            read_host_name: laptop_host,
        };
        let error = init(&root, None, &failing).expect_err("the commit fails");
        assert!(matches!(error, StoreError::Git { .. }), "{error:?}");

        let outcome =
            init(&root, None, &effects_with_host(laptop_host)).expect("the retry succeeds");

        assert_eq!(
            outcome,
            InitOutcome {
                store: root.clone(),
                created: true
            }
        );
        assert_eq!(commit_count(&root), "1");
        assert_eq!(
            git_output(&root, &["ls-tree", "--name-only", "main"]),
            ".gitattributes\ntikk.json"
        );
        assert_eq!(machine_file(&root), "laptop\n");
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

    fn git_in(directory: &Path, arguments: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(directory)
            .args(arguments)
            .env_remove("GIT_DIR")
            .env_remove("GIT_INDEX_FILE")
            .status()
            .expect("start git");

        assert!(status.success(), "git {arguments:?} failed");
    }

    #[test]
    fn init_inside_another_repository_leaves_that_repository_alone() {
        let directory = temporary_directory();
        let parent = directory.path();
        git_in(parent, &["init", "--quiet"]);
        fs::write(parent.join("unrelated.txt"), "parent work").expect("write a parent file");
        git_in(parent, &["add", "unrelated.txt"]);
        let root = parent.join("candidate");
        fs::create_dir(&root).expect("create the store folder");
        fs::write(root.join("tikk.json"), "{\"version\":1}\n").expect("write tikk.json");

        let error = init(&root, None, &effects_with_host(laptop_host))
            .expect_err("a folder without its own repository is not a store");

        assert!(
            matches!(&error, StoreError::FolderNotEmpty { store } if *store == root),
            "{error:?}"
        );
        assert_eq!(git_output(parent, &["rev-list", "--all", "--count"]), "0");
        assert_eq!(
            git_output(parent, &["diff", "--cached", "--name-only"]),
            "unrelated.txt"
        );
        assert!(!root.join(".git").exists());
    }

    #[test]
    fn init_refuses_a_tikk_json_that_is_not_version_1_and_writes_nothing() {
        for config in ["{\"version\":2}", "not json", "{}"] {
            let directory = temporary_directory();
            let root = directory.path().to_path_buf();
            fs::write(root.join("tikk.json"), config).expect("write tikk.json");

            let error = init(&root, None, &effects_with_host(laptop_host))
                .expect_err("a foreign tikk.json is refused");

            assert!(
                matches!(&error, StoreError::InvalidConfig { path } if *path == root.join("tikk.json")),
                "case {config}: {error:?}"
            );
            let names: Vec<_> = fs::read_dir(&root)
                .expect("read the folder")
                .map(|entry| entry.expect("read an entry").file_name())
                .collect();
            assert_eq!(names, vec![OsString::from("tikk.json")], "case {config}");
        }
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
