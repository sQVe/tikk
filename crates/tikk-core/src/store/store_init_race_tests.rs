use std::cell::RefCell;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use super::tests::{commit_count, laptop_host, machine_file, sorted_names, temporary_directory};
use super::{InitOutcome, init};
use crate::store::{MachineName, StoreEffects, StoreError};

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
