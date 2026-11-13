use std::cell::Cell;
use std::fs;
use std::path::{Path, PathBuf};

use tempfile::TempDir;

use crate::fact::AgentName;
use crate::store::git::run_store_git;
use crate::store::id_clash::IdClash;
use crate::store::identity::Identity;
use crate::store::sync::{FileEntry, FileKind, SyncEffects, SyncStep};
use crate::store::sync_read::read_entry;
use crate::store::ticket_claim::{ClaimEffects, claim_slice};
use crate::store::{
    MachineName, RemoteInitEffects, Store, StoreEffects, StoreError, init, init_from_remote,
};
use crate::ticket::TicketId;

const FETCHED: &str = "1111111111111111111111111111111111111111";

thread_local! {
    static MERGE_STARTED: Cell<bool> = const { Cell::new(false) };
    static ABORT_FAILS: Cell<bool> = const { Cell::new(false) };
    static HEAD_STAYS: Cell<bool> = const { Cell::new(false) };
    static CONFLICT: Cell<bool> = const { Cell::new(false) };
}

const PLAN_FILE: &str = "tickets/personal/personal-pppp-plan.md";

fn origin(_: &Path) -> Result<Option<String>, StoreError> {
    Ok(Some("git@example.com:owner/tikk-store.git".to_owned()))
}

fn fetch_without_network(_: &Path, _: &[&str]) -> Result<Vec<u8>, StoreError> {
    Ok(Vec::new())
}

fn failed(arguments: &[&str]) -> StoreError {
    StoreError::Git {
        arguments: arguments.join(" "),
        message: "merge failed".to_owned(),
    }
}

fn git_with_a_failing_merge(root: &Path, arguments: &[&str]) -> Result<Vec<u8>, StoreError> {
    match arguments {
        ["for-each-ref", ..] => Ok(FETCHED.as_bytes().to_vec()),
        ["rev-list", ..] => Ok(b"1\n".to_vec()),
        ["merge", "--abort"] if ABORT_FAILS.get() => Err(failed(arguments)),
        ["merge", "--abort"] => {
            MERGE_STARTED.set(HEAD_STAYS.get());

            Ok(Vec::new())
        }
        ["diff", "--name-only", ..] if CONFLICT.get() => Ok(format!("{PLAN_FILE}\0").into_bytes()),
        ["merge", ..] => {
            MERGE_STARTED.set(ABORT_FAILS.get() || HEAD_STAYS.get() || CONFLICT.get());

            Err(failed(arguments))
        }
        _ => run_store_git(root, arguments),
    }
}

fn entry_with_merge_head(path: &Path) -> Result<Option<FileEntry>, StoreError> {
    if path.ends_with(".git/MERGE_HEAD") && MERGE_STARTED.get() {
        return Ok(Some(FileEntry {
            bytes: FETCHED.as_bytes().to_vec(),
            kind: FileKind::File,
            modified: std::time::SystemTime::now(),
        }));
    }

    read_entry(path)
}

fn effects() -> ClaimEffects {
    ClaimEffects {
        sync: SyncEffects {
            read_origin: origin,
            run_network_git: fetch_without_network,
            run_git: git_with_a_failing_merge,
            read_entry: entry_with_merge_head,
            ..SyncEffects::system()
        },
        ..ClaimEffects::system()
    }
}

fn store_with_slice() -> (TempDir, Store) {
    let directory = tempfile::tempdir().expect("create a temporary directory");
    let machine = MachineName::parse("test").expect("a valid machine name");
    init(directory.path(), Some(machine), &StoreEffects::system()).expect("init the store");

    with_slice(directory)
}

fn with_slice(directory: TempDir) -> (TempDir, Store) {
    let folder = directory.path().join("tickets/personal");
    fs::create_dir_all(&folder).expect("create the project folder");
    fs::write(
        folder.join("personal-pppp-plan.md"),
        "---\nkind: plan\ntitle: Plan\n---\n",
    )
    .expect("write the plan");
    fs::write(
        folder.join("personal-kkkk-slice.md"),
        "---\nkind: slice\ntitle: Slice\nparent: personal-pppp\ncriteria:\n  - id: s1\n    check: c\n    expected: e\n---\n",
    )
    .expect("write the slice");
    let store = Store {
        root: directory.path().to_path_buf(),
    };

    (directory, store)
}

fn manager() -> Identity {
    Identity {
        agent: AgentName::parse("manager"),
        ..Identity::default()
    }
}

fn slice() -> TicketId {
    TicketId::parse("personal-kkkk").expect("a valid ID")
}

#[test]
fn a_refused_merge_is_a_merge_problem_and_the_claim_is_appended_and_committed() {
    let (directory, store) = store_with_slice();
    ABORT_FAILS.set(false);
    HEAD_STAYS.set(false);
    CONFLICT.set(false);

    let synced = claim_slice(&store, &slice(), &manager(), &effects()).expect("the claim works");

    assert_eq!(synced.sync.problems[0].step, SyncStep::Merge);
    assert!(!synced.sync.merged);
    assert!(!synced.sync.pushed, "a failed merge skips the push");
    assert!(
        synced
            .sync
            .committed_paths
            .iter()
            .any(|path| path.starts_with("facts/")),
        "{:?}",
        synced.sync
    );
    assert!(directory.path().join("facts").exists());
}

#[test]
fn a_merge_that_cannot_be_aborted_fails_the_claim_and_appends_nothing() {
    let (directory, store) = store_with_slice();
    ABORT_FAILS.set(true);
    HEAD_STAYS.set(false);
    CONFLICT.set(false);

    let result = claim_slice(&store, &slice(), &manager(), &effects());

    assert!(
        matches!(&result, Err(StoreError::MergeAbortFailed { .. })),
        "{result:?}"
    );
    assert!(!directory.path().join("facts").exists());
}

#[test]
fn a_merge_that_stays_in_progress_after_its_abort_fails_the_claim_and_appends_nothing() {
    let (directory, store) = store_with_slice();
    ABORT_FAILS.set(false);
    HEAD_STAYS.set(true);
    CONFLICT.set(false);

    let result = claim_slice(&store, &slice(), &manager(), &effects());

    assert!(
        matches!(&result, Err(StoreError::MergeInProgress { .. })),
        "{result:?}"
    );
    assert!(!directory.path().join("facts").exists());
}

fn saved_result(directory: &TempDir) -> serde_json::Value {
    serde_json::from_str(
        &fs::read_to_string(directory.path().join(".git/tikk-sync.json"))
            .expect("read the saved result"),
    )
    .expect("the saved result is JSON")
}

#[test]
fn a_claim_with_nothing_to_merge_commits_and_pushes_with_no_problem() {
    let remote = tempfile::tempdir().expect("create the remote folder");
    run_store_git(
        remote.path(),
        &["init", "--quiet", "--bare", "--initial-branch=main"],
    )
    .expect("create the bare remote");
    let directory = tempfile::tempdir().expect("create a temporary directory");
    init_from_remote(
        directory.path(),
        remote.path().to_str().expect("a UTF-8 path"),
        Some(MachineName::parse("laptop").expect("a valid machine name")),
        &RemoteInitEffects::system(),
    )
    .expect("init from the remote");
    let (directory, store) = with_slice(directory);

    let synced = claim_slice(&store, &slice(), &manager(), &ClaimEffects::system())
        .expect("the claim works");

    assert!(synced.sync.problems.is_empty(), "{:?}", synced.sync);
    assert!(
        synced.sync.fetched && !synced.sync.merged,
        "{:?}",
        synced.sync
    );
    assert!(synced.sync.pushed, "{:?}", synced.sync);
    assert_eq!(
        run_store_git(remote.path(), &["rev-parse", "main"]).expect("read the remote main"),
        run_store_git(directory.path(), &["rev-parse", "HEAD"]).expect("read HEAD")
    );
}

#[test]
fn a_claim_lists_the_id_clashes_of_the_store_in_its_sync_result() {
    let (directory, store) = store_with_slice();
    let task = "---\nkind: task\ntitle: Task\n---\n";
    let folder = directory.path().join("tickets/personal");
    fs::write(folder.join("personal-tttt-a.md"), task).expect("write a task");
    fs::write(folder.join("personal-tttt-b.md"), task).expect("write a task with the same ID");

    let synced = claim_slice(&store, &slice(), &manager(), &ClaimEffects::system())
        .expect("a clash of another ID does not stop the claim");

    assert_eq!(
        synced.sync.clashes,
        [IdClash {
            id: TicketId::parse("personal-tttt").expect("a valid ID"),
            paths: vec![
                PathBuf::from("tickets/personal/personal-tttt-a.md"),
                PathBuf::from("tickets/personal/personal-tttt-b.md"),
            ],
        }]
    );
}

#[test]
fn a_claim_refused_for_a_shared_id_saves_the_clash_and_appends_nothing() {
    let (directory, store) = store_with_slice();
    let folder = directory.path().join("tickets/personal");
    fs::copy(
        folder.join("personal-kkkk-slice.md"),
        folder.join("personal-kkkk-copy.md"),
    )
    .expect("put a second file with the ID");

    let result = claim_slice(&store, &slice(), &manager(), &ClaimEffects::system());

    assert!(
        matches!(&result, Err(StoreError::IdShared { .. })),
        "{result:?}"
    );
    assert_eq!(
        saved_result(&directory)["clashes"],
        serde_json::json!([{
            "id": "personal-kkkk",
            "paths": [
                "tickets/personal/personal-kkkk-copy.md",
                "tickets/personal/personal-kkkk-slice.md",
            ],
        }])
    );
    assert!(!directory.path().join("facts").exists());
}

#[test]
fn a_merge_conflict_in_a_claim_names_its_files_in_the_merge_problem() {
    let (_directory, store) = store_with_slice();
    ABORT_FAILS.set(false);
    HEAD_STAYS.set(false);
    CONFLICT.set(true);

    let synced = claim_slice(&store, &slice(), &manager(), &effects()).expect("the claim works");

    assert_eq!(synced.sync.problems[0].step, SyncStep::Merge);
    assert_eq!(synced.sync.problems[0].files, [PLAN_FILE]);
}
