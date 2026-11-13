use std::cell::RefCell;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;

use super::{InitOutcome, init, join_another_init};
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

fn git_without_commit(directory: &Path, arguments: &[&str]) -> Result<Vec<u8>, StoreError> {
    if arguments.contains(&"commit") {
        return Err(StoreError::Git {
            arguments: arguments.join(" "),
            message: "the commit fails in this test".to_owned(),
        });
    }

    (StoreEffects::system().run_git)(directory, arguments)
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
    fs::set_permissions(&root, fs::Permissions::from_mode(0o300)).expect("remove read permission");

    let result = init(&root, None, &effects_with_host(laptop_host));

    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("restore read permission");
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
fn init_refuses_a_repository_with_commits_but_no_tikk_json() {
    let directory = temporary_directory();
    let root = directory.path().join("store");
    fs::create_dir(&root).expect("create the store folder");
    git_in(&root, &["init", "--quiet", "--initial-branch=main"]);
    git_in(
        &root,
        &[
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@localhost",
            "commit",
            "--quiet",
            "--allow-empty",
            "--message",
            "someone else's work",
        ],
    );

    let error = init(&root, None, &effects_with_host(laptop_host))
        .expect_err("a repository with history is not an unfinished init");

    assert!(
        matches!(&error, StoreError::FolderNotEmpty { store } if *store == root),
        "{error:?}"
    );
    assert_eq!(commit_count(&root), "1");
    assert!(!root.join("tikk.json").exists());
}

fn sorted_names(directory: &Path) -> Vec<OsString> {
    let mut names: Vec<_> = fs::read_dir(directory)
        .expect("read the folder")
        .map(|entry| entry.expect("read an entry").file_name())
        .collect();

    names.sort();

    names
}

#[test]
fn init_ignores_a_staging_folder_left_by_a_crash() {
    let directory = temporary_directory();
    let root = directory.path().join("store");
    let leftover = directory.path().join(".store.tikk-init-crashed");
    fs::create_dir_all(leftover.join(".git")).expect("create a leftover staging folder");
    fs::write(leftover.join("tikk.json"), "{\"version\":1}\n").expect("write tikk.json");

    let outcome = init(&root, None, &effects_with_host(laptop_host))
        .expect("a leftover staging folder does not block init");

    assert!(outcome.created);
    assert_eq!(commit_count(&root), "1");
}

#[test]
fn a_failed_first_commit_leaves_no_store_and_no_staging_folder() {
    let failing = StoreEffects {
        run_git: git_without_commit,
        read_host_name: laptop_host,
    };

    for store_exists in [false, true] {
        let directory = temporary_directory();
        let root = directory.path().join("store");
        if store_exists {
            fs::create_dir(&root).expect("create an empty store folder");
        }

        let error = init(&root, None, &failing).expect_err("the commit fails");

        assert!(
            matches!(error, StoreError::Git { .. }),
            "case {store_exists}: {error:?}"
        );
        let expected: Vec<OsString> = if store_exists {
            vec![OsString::from("store")]
        } else {
            Vec::new()
        };
        assert_eq!(
            sorted_names(directory.path()),
            expected,
            "case {store_exists}"
        );
        if store_exists {
            assert_eq!(sorted_names(&root), Vec::<OsString>::new());
        }
    }
}

#[test]
fn init_refuses_a_git_symlink_to_another_repository() {
    let directory = temporary_directory();
    let other = directory.path().join("other");
    fs::create_dir(&other).expect("create the other repository");
    git_in(&other, &["init", "--quiet"]);
    fs::write(other.join("work.txt"), "other work").expect("write a file");
    git_in(&other, &["add", "work.txt"]);
    let root = directory.path().join("store");
    fs::create_dir(&root).expect("create the store folder");
    fs::write(root.join("tikk.json"), "{\"version\":1}\n").expect("write tikk.json");
    std::os::unix::fs::symlink(other.join(".git"), root.join(".git"))
        .expect("link .git to the other repository");

    let error = init(
        &root,
        Some(MachineName::parse("laptop").expect("a valid name")),
        &effects_with_host(laptop_host),
    )
    .expect_err("a linked .git is not the store's repository");

    assert!(
        matches!(&error, StoreError::ForeignRepository { store } if *store == root),
        "{error:?}"
    );
    assert_eq!(git_output(&other, &["rev-list", "--all", "--count"]), "0");
    assert_eq!(
        git_output(&other, &["diff", "--cached", "--name-only"]),
        "work.txt"
    );
    assert!(!other.join(".git/tikk-machine").exists());
}

#[test]
fn init_refuses_a_lone_gitattributes_or_git_init_result() {
    let directory = temporary_directory();
    let attributes_only = directory.path().join("attributes");
    fs::create_dir(&attributes_only).expect("create the folder");
    fs::write(attributes_only.join(".gitattributes"), "* text\n").expect("write .gitattributes");
    let git_only = directory.path().join("git");
    fs::create_dir(&git_only).expect("create the folder");
    git_in(&git_only, &["init", "--quiet", "--initial-branch=main"]);

    for root in [&attributes_only, &git_only] {
        let before = sorted_names(root);

        let error = init(root, None, &effects_with_host(laptop_host))
            .expect_err("leftovers are not a store");

        assert!(
            matches!(&error, StoreError::FolderNotEmpty { store } if store == root),
            "case {}: {error:?}",
            root.display()
        );
        assert_eq!(sorted_names(root), before, "case {}", root.display());
    }
    assert_eq!(
        fs::read_to_string(attributes_only.join(".gitattributes")).expect("read .gitattributes"),
        "* text\n"
    );
    assert_eq!(
        git_output(&git_only, &["rev-list", "--all", "--count"]),
        "0"
    );
}

#[test]
fn init_refuses_a_store_without_its_first_commit() {
    let directory = temporary_directory();
    let root = directory.path().join("store");
    fs::create_dir(&root).expect("create the store folder");
    git_in(&root, &["init", "--quiet", "--initial-branch=main"]);
    fs::write(root.join("tikk.json"), "{\"version\":1}\n").expect("write tikk.json");

    let error = init(&root, None, &effects_with_host(laptop_host))
        .expect_err("a store without its first commit is refused");

    assert!(
        matches!(&error, StoreError::FolderNotEmpty { store } if *store == root),
        "{error:?}"
    );
    assert_eq!(git_output(&root, &["rev-list", "--all", "--count"]), "0");
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
fn init_refuses_an_empty_git_folder_inside_another_repository() {
    let directory = temporary_directory();
    let parent = directory.path();
    git_in(parent, &["init", "--quiet"]);
    fs::write(parent.join("unrelated.txt"), "parent work").expect("write a parent file");
    git_in(parent, &["add", "unrelated.txt"]);
    let root = parent.join("candidate");
    fs::create_dir_all(root.join(".git")).expect("create an empty .git folder");
    fs::write(root.join("tikk.json"), "{\"version\":1}\n").expect("write tikk.json");

    let error = init(
        &root,
        Some(MachineName::parse("laptop").expect("a valid name")),
        &effects_with_host(laptop_host),
    )
    .expect_err("an empty .git folder is not the store's repository");

    assert!(
        matches!(&error, StoreError::ForeignRepository { store } if *store == root),
        "{error:?}"
    );
    assert_eq!(git_output(parent, &["rev-list", "--all", "--count"]), "0");
    assert_eq!(
        git_output(parent, &["diff", "--cached", "--name-only"]),
        "unrelated.txt"
    );
    let git_entries = fs::read_dir(root.join(".git")).expect("read .git").count();
    assert_eq!(git_entries, 0);
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

thread_local! {
    static RACED_ROOT: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

fn raced_root() -> PathBuf {
    RACED_ROOT.with(|root| root.borrow().clone().expect("the test sets the raced root"))
}

fn git_losing_the_race(directory: &Path, arguments: &[&str]) -> Result<Vec<u8>, StoreError> {
    if arguments.contains(&"commit") {
        let winner = Some(MachineName::parse("winner").expect("a valid name"));

        init(&raced_root(), winner, &StoreEffects::system())?;
    }

    (StoreEffects::system().run_git)(directory, arguments)
}

fn git_after_a_stray_file(directory: &Path, arguments: &[&str]) -> Result<Vec<u8>, StoreError> {
    if arguments.contains(&"commit") {
        let root = raced_root();

        fs::create_dir_all(&root).expect("create the store folder");
        fs::write(root.join("notes.txt"), "mine").expect("write a stray file");
    }

    (StoreEffects::system().run_git)(directory, arguments)
}

// Another program writes a plain file at the raced root just before the first commit, so the rename
// of the store folder onto it fails with an error that is not a collision.
fn git_after_a_file_at_the_store_path(
    directory: &Path,
    arguments: &[&str],
) -> Result<Vec<u8>, StoreError> {
    if arguments.contains(&"commit") {
        fs::write(raced_root(), "not a folder").expect("write a file at the store path");
    }

    (StoreEffects::system().run_git)(directory, arguments)
}

#[test]
fn init_reports_a_rename_error_that_is_not_a_collision_and_keeps_the_destination() {
    let directory = temporary_directory();
    let root = directory.path().join("store");
    RACED_ROOT.with(|raced| raced.replace(Some(root.clone())));
    let effects = StoreEffects {
        run_git: git_after_a_file_at_the_store_path,
        read_host_name: laptop_host,
    };

    let error = init(&root, None, &effects).expect_err("a folder cannot replace a file");

    assert!(
        matches!(
            &error,
            StoreError::Io { action: "rename", path, source }
                if *path == root && source.kind() == std::io::ErrorKind::NotADirectory
        ),
        "{error:?}"
    );
    assert_eq!(
        fs::read_to_string(&root).expect("read the file at the store path"),
        "not a folder"
    );
    assert_eq!(
        sorted_names(directory.path()),
        vec![OsString::from("store")]
    );
}

#[test]
fn init_that_loses_the_rename_reports_the_winning_store() {
    let directory = temporary_directory();
    let root = directory.path().join("store");
    fs::create_dir(&root).expect("create an empty store folder");
    RACED_ROOT.with(|raced| raced.replace(Some(root.clone())));
    let effects = StoreEffects {
        run_git: git_losing_the_race,
        read_host_name: laptop_host,
    };

    let outcome = init(&root, None, &effects).expect("the winning store is accepted");

    assert_eq!(
        outcome,
        InitOutcome {
            store: root.clone(),
            created: false
        }
    );
    assert_eq!(commit_count(&root), "1");
    assert_eq!(machine_file(&root), "winner\n");
    assert_eq!(
        sorted_names(directory.path()),
        vec![OsString::from("store")]
    );
}

#[test]
fn init_that_loses_the_rename_to_other_files_reports_them() {
    let directory = temporary_directory();
    let root = directory.path().join("store");
    RACED_ROOT.with(|raced| raced.replace(Some(root.clone())));
    let effects = StoreEffects {
        run_git: git_after_a_stray_file,
        read_host_name: laptop_host,
    };

    let error = init(&root, None, &effects).expect_err("the folder is not a store");

    assert!(
        matches!(&error, StoreError::FolderNotEmpty { store } if *store == root),
        "{error:?}"
    );
    assert_eq!(
        sorted_names(directory.path()),
        vec![OsString::from("store")]
    );
    assert_eq!(sorted_names(&root), vec![OsString::from("notes.txt")]);
}

#[test]
fn join_another_init_accepts_a_store_and_returns_the_error_otherwise() {
    let directory = temporary_directory();
    let store = directory.path().join("store");
    let other = directory.path().join("other");
    init(&store, None, &effects_with_host(laptop_host)).expect("the other init succeeds");
    fs::create_dir(&other).expect("create a folder");
    let not_empty = |root: &Path| StoreError::FolderNotEmpty {
        store: root.to_path_buf(),
    };
    let desk = MachineName::parse("desk").expect("a valid name");

    let joined = join_another_init(
        &store,
        Some(desk),
        &effects_with_host(missing_host),
        not_empty(&store),
    )
    .expect("the store exists");
    let refused = join_another_init(
        &other,
        None,
        &effects_with_host(missing_host),
        not_empty(&other),
    )
    .expect_err("no store exists");

    assert!(!joined.created);
    assert_eq!(machine_file(&store), "desk\n");
    assert!(
        matches!(&refused, StoreError::FolderNotEmpty { store } if *store == other),
        "{refused:?}"
    );
}

#[test]
fn init_accepts_a_store_path_that_is_not_utf8() {
    use std::os::unix::ffi::OsStrExt as _;

    let directory = temporary_directory();
    let root = directory
        .path()
        .join(std::ffi::OsStr::from_bytes(b"store-\xff"));
    init(&root, None, &effects_with_host(laptop_host)).expect("first init succeeds");

    let second = init(&root, None, &effects_with_host(laptop_host)).expect("the store exists");

    assert!(!second.created);
}
