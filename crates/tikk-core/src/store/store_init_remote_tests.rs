use std::fs;
use std::path::{Path, PathBuf};

use tempfile::TempDir;

use super::{RemoteInitEffects, init_from_remote};
use crate::store::git::run_store_git;
use crate::store::{MachineName, StoreEffects, StoreError, init};

struct Setup {
    directory: TempDir,
}

impl Setup {
    fn new() -> Self {
        let setup = Self {
            directory: tempfile::tempdir().expect("create a temporary directory"),
        };

        run_store_git(
            setup.directory.path(),
            &[
                "init",
                "--quiet",
                "--bare",
                "--initial-branch=main",
                "remote.git",
            ],
        )
        .expect("create the bare remote");

        setup
    }

    fn store(&self) -> PathBuf {
        self.directory.path().join("store")
    }

    fn remote(&self) -> String {
        self.directory
            .path()
            .join("remote.git")
            .to_str()
            .expect("a UTF-8 path")
            .to_owned()
    }

    fn push_to_remote(&self, branch: &str, files: &[(&str, &str)]) {
        let scratch = self.directory.path().join(format!("scratch-{branch}"));
        let git = |arguments: &[&str]| run_store_git(&scratch, arguments).expect("git runs");
        fs::create_dir_all(&scratch).expect("create the scratch folder");
        git(&["init", "--quiet", "--initial-branch", branch]);

        for (path, text) in files {
            let path = scratch.join(path);
            fs::create_dir_all(path.parent().expect("a file has a folder"))
                .expect("create the folder");
            fs::write(path, text).expect("write a file");
        }

        git(&["add", "--all"]);
        git(&["commit", "--quiet", "--message", "Set up"]);
        git(&["push", "--quiet", &self.remote(), branch]);
    }

    fn leftovers(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(self.directory.path())
            .expect("list the parent")
            .map(|entry| {
                entry
                    .expect("read an entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .filter(|name| name != "remote.git" && !name.starts_with("scratch-"))
            .collect();

        names.sort();

        names
    }
}

fn host_name() -> Result<String, StoreError> {
    Ok("Laptop.example.com\n".to_owned())
}

fn effects() -> RemoteInitEffects {
    RemoteInitEffects {
        read_host_name: host_name,
        ..RemoteInitEffects::system()
    }
}

fn failing_push(directory: &Path, arguments: &[&str]) -> Result<Vec<u8>, StoreError> {
    if arguments.first() == Some(&"push") {
        return Err(StoreError::Git {
            arguments: arguments.join(" "),
            message: "rejected".to_owned(),
        });
    }

    run_store_git(directory, arguments)
}

fn git(root: &Path, arguments: &[&str]) -> String {
    String::from_utf8(run_store_git(root, arguments).expect("git runs")).expect("UTF-8 output")
}

fn machine(name: &str) -> Option<MachineName> {
    Some(MachineName::parse(name).expect("a valid machine name"))
}

const STORE_FILES: &[(&str, &str)] = &[
    ("tikk.json", "{\"version\":1}\n"),
    (".gitattributes", "facts/** merge=union\n"),
];

#[test]
fn an_empty_remote_gets_a_new_store_pushed_to_its_main() {
    let setup = Setup::new();

    let outcome = init_from_remote(&setup.store(), &setup.remote(), None, &effects())
        .expect("the store is created");

    assert!(outcome.created);
    assert_eq!(
        fs::read_to_string(setup.store().join(".git/tikk-machine")).expect("read the machine"),
        "laptop\n"
    );
    assert_eq!(
        git(&setup.store(), &["config", "--get", "remote.origin.url"]).trim(),
        setup.remote()
    );
    assert_eq!(
        git(Path::new(&setup.remote()), &["rev-parse", "main"]),
        git(&setup.store(), &["rev-parse", "main"])
    );
    assert_eq!(setup.leftovers(), ["store"]);
}

#[test]
fn a_remote_with_main_is_cloned_with_this_machine_saved() {
    let setup = Setup::new();
    setup.push_to_remote("main", STORE_FILES);

    let outcome = init_from_remote(&setup.store(), &setup.remote(), machine("desk"), &effects())
        .expect("the store is cloned");

    assert!(outcome.created);
    assert_eq!(
        git(&setup.store(), &["rev-parse", "HEAD"]),
        git(Path::new(&setup.remote()), &["rev-parse", "main"])
    );
    assert_eq!(
        fs::read_to_string(setup.store().join(".git/tikk-machine")).expect("read the machine"),
        "desk\n"
    );
    assert_eq!(setup.leftovers(), ["store"]);
}

#[test]
fn a_remote_that_holds_the_host_machine_folder_needs_machine() {
    let setup = Setup::new();
    let mut files = STORE_FILES.to_vec();
    files.push(("facts/laptop/2026-11.jsonl", ""));
    setup.push_to_remote("main", &files);

    let refused = init_from_remote(&setup.store(), &setup.remote(), None, &effects())
        .expect_err("the machine folder is taken");
    let leftovers = setup.leftovers();
    let chosen = init_from_remote(
        &setup.store(),
        &setup.remote(),
        machine("laptop"),
        &effects(),
    );

    assert!(
        matches!(&refused, StoreError::MachineInUse { machine } if machine == "laptop"),
        "{refused:?}"
    );
    assert_eq!(leftovers, Vec::<String>::new());
    assert!(chosen.is_ok_and(|outcome| outcome.created));
}

#[test]
fn a_remote_without_main_or_without_a_store_is_refused() {
    let without_main = Setup::new();
    without_main.push_to_remote("work", STORE_FILES);
    let not_a_store = Setup::new();
    not_a_store.push_to_remote("main", &[("README.md", "hello\n")]);

    let first = init_from_remote(
        &without_main.store(),
        &without_main.remote(),
        None,
        &effects(),
    );
    let second = init_from_remote(
        &not_a_store.store(),
        &not_a_store.remote(),
        None,
        &effects(),
    );

    assert!(
        matches!(&first, Err(StoreError::RemoteWithoutMain { url }) if *url == without_main.remote()),
        "{first:?}"
    );
    assert!(
        matches!(&second, Err(StoreError::RemoteNotAStore { url }) if *url == not_a_store.remote()),
        "{second:?}"
    );
    assert_eq!(without_main.leftovers(), Vec::<String>::new());
    assert_eq!(not_a_store.leftovers(), Vec::<String>::new());
}

#[test]
fn a_remote_that_cannot_be_read_is_an_error_and_nothing_is_created() {
    let setup = Setup::new();
    let missing = setup.directory.path().join("missing.git");

    let error = init_from_remote(
        &setup.store(),
        missing.to_str().expect("a UTF-8 path"),
        None,
        &effects(),
    )
    .expect_err("the remote does not exist");

    assert!(
        matches!(&error, StoreError::Git { arguments, .. } if arguments.starts_with("ls-remote")),
        "{error:?}"
    );
    assert_eq!(setup.leftovers(), Vec::<String>::new());
}

#[test]
fn a_failed_push_of_a_new_store_creates_nothing() {
    let setup = Setup::new();
    let effects = RemoteInitEffects {
        run_network_git: failing_push,
        ..effects()
    };

    let error = init_from_remote(&setup.store(), &setup.remote(), None, &effects)
        .expect_err("the push fails");

    assert!(
        matches!(&error, StoreError::Git { arguments, .. } if arguments.starts_with("push")),
        "{error:?}"
    );
    assert_eq!(setup.leftovers(), Vec::<String>::new());
}

#[test]
fn an_existing_store_is_reported_and_not_attached() {
    let setup = Setup::new();
    let local = StoreEffects {
        run_git: run_store_git,
        read_host_name: host_name,
    };
    init(&setup.store(), machine("laptop"), &local).expect("create a local store");

    let outcome = init_from_remote(&setup.store(), &setup.remote(), None, &effects())
        .expect("the store exists");

    assert!(!outcome.created);
    assert!(
        run_store_git(&setup.store(), &["config", "--get", "remote.origin.url"]).is_err(),
        "the store got an origin"
    );
    assert_eq!(
        git(Path::new(&setup.remote()), &["for-each-ref"]),
        "",
        "the remote got a branch"
    );
}

#[test]
fn a_folder_with_other_files_is_refused_before_the_remote_is_touched() {
    let setup = Setup::new();
    fs::create_dir_all(setup.store()).expect("create the store folder");
    fs::write(setup.store().join("notes.txt"), "mine\n").expect("write a file");

    let error = init_from_remote(&setup.store(), &setup.remote(), None, &effects())
        .expect_err("the folder holds other files");

    assert!(
        matches!(error, StoreError::FolderNotEmpty { .. }),
        "{error:?}"
    );
    assert_eq!(git(Path::new(&setup.remote()), &["for-each-ref"]), "");
    assert_eq!(setup.leftovers(), ["store"]);
}
