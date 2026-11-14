use std::cell::Cell;
use std::fs;
use std::path::{Path, PathBuf};

use tempfile::TempDir;

use crate::fact::{AgentName, FactEvent};
use crate::store::fact_files::read_facts;
use crate::store::git::run_store_git;
use crate::store::id_clash::IdClash;
use crate::store::identity::Identity;
use crate::store::sync::{FileEntry, FileKind, SyncEffects, SyncStep};
use crate::store::sync_read::read_entry;
use crate::store::test_support::sync_remote::{
    bare_remote, git_text, store_files, store_on_remote,
};
use crate::store::ticket_claim::{ClaimEffects, claim_slice, release_slice};
use crate::store::{MachineName, Store, StoreEffects, StoreError, init};
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
    let remote = bare_remote();
    let (directory, store) = with_slice(store_on_remote(remote.path(), "laptop"));

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
    let fact_files = git_text(
        directory.path(),
        &["ls-tree", "-r", "--name-only", "HEAD", "facts"],
    );
    let committed = git_text(
        directory.path(),
        &["show", &format!("HEAD:{}", fact_files.trim())],
    );
    assert!(
        committed.contains("\"kind\":\"claim\",\"ticket\":\"personal-kkkk\""),
        "the commit holds the claim line: {committed}"
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

fn store_state(directory: &TempDir) -> (String, String, Vec<(PathBuf, Vec<u8>)>) {
    let root = directory.path();

    (
        git_text(root, &["rev-parse", "HEAD"]),
        git_text(root, &["status", "--porcelain", "--untracked-files=all"]),
        store_files(root),
    )
}

fn entry_failing_on_the_plan(path: &Path) -> Result<Option<FileEntry>, StoreError> {
    if path.ends_with(PLAN_FILE) {
        return Err(StoreError::Io {
            action: "read",
            path: path.to_path_buf(),
            source: std::io::Error::other("unreadable"),
        });
    }

    read_entry(path)
}

#[test]
fn a_claim_in_a_store_with_a_deleted_committed_fact_file_is_refused_and_changes_nothing() {
    let (directory, store) = store_with_slice();
    let fact = "facts/test/2020-01.jsonl";
    let line = "{\"v\":1,\"kind\":\"release\",\"ticket\":\"personal-kkkk\",\"at\":\"2020-01-01T00:00:00Z\",\"agent\":null}\n";
    fs::create_dir_all(directory.path().join("facts/test")).expect("create the fact folder");
    fs::write(directory.path().join(fact), line).expect("write a fact file");
    git_text(directory.path(), &["add", "--", fact]);
    git_text(
        directory.path(),
        &["commit", "--quiet", "--message", "Add a fact"],
    );
    fs::remove_file(directory.path().join(fact)).expect("delete the committed fact file");
    let before = store_state(&directory);

    let result = claim_slice(&store, &slice(), &manager(), &ClaimEffects::system());

    assert!(
        matches!(&result, Err(StoreError::FactRewritten { path }) if path.ends_with(fact)),
        "{result:?}"
    );
    assert_eq!(store_state(&directory), before);
}

#[test]
fn a_claim_whose_changed_file_read_fails_is_refused_and_changes_nothing() {
    let (directory, store) = store_with_slice();
    let effects = ClaimEffects {
        sync: SyncEffects {
            read_entry: entry_failing_on_the_plan,
            ..SyncEffects::system()
        },
        ..ClaimEffects::system()
    };
    let before = store_state(&directory);

    let result = claim_slice(&store, &slice(), &manager(), &effects);

    assert!(
        matches!(&result, Err(StoreError::Io { path, .. }) if path.ends_with(PLAN_FILE)),
        "{result:?}"
    );
    assert_eq!(store_state(&directory), before);
    assert!(
        saved_result(&directory)["error"].is_string(),
        "the error is saved as the last sync result"
    );
}

fn commit_and_push(root: &Path, message: &str) {
    git_text(root, &["add", "--all"]);
    git_text(root, &["commit", "--quiet", "--message", message]);
    git_text(root, &["push", "--quiet", "origin", "main"]);
}

#[test]
fn a_claim_whose_ticket_scan_fails_is_refused_before_the_merge_and_changes_nothing() {
    let remote = bare_remote();
    let (laptop, _laptop_store) = with_slice(store_on_remote(remote.path(), "laptop"));
    commit_and_push(laptop.path(), "Add the slice");
    let desktop = store_on_remote(remote.path(), "desktop");
    fs::write(
        laptop.path().join("tickets/personal/personal-tttt-task.md"),
        "---\nkind: task\ntitle: Task\n---\n",
    )
    .expect("write a task on the laptop");
    commit_and_push(laptop.path(), "Add a task");
    std::os::unix::fs::symlink(
        "missing.md",
        desktop
            .path()
            .join("tickets/personal/personal-zzzz-link.md"),
    )
    .expect("leave a dangling ticket symlink");
    let store = Store {
        root: desktop.path().to_path_buf(),
    };
    let before = store_state(&desktop);

    let result = claim_slice(&store, &slice(), &manager(), &ClaimEffects::system());

    assert!(
        matches!(&result, Err(StoreError::Io { path, .. }) if path.ends_with("personal-zzzz-link.md")),
        "{result:?}"
    );
    assert_eq!(store_state(&desktop), before, "no merge, fact, or commit");
}

thread_local! {
    static NETWORK: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn recorded_network(_: &Path, arguments: &[&str]) -> Result<Vec<u8>, StoreError> {
    NETWORK.with_borrow_mut(|calls| calls.push(arguments.join(" ")));

    Ok(Vec::new())
}

fn git_with_a_failing_commit(root: &Path, arguments: &[&str]) -> Result<Vec<u8>, StoreError> {
    match arguments {
        ["commit", ..] => Err(StoreError::Git {
            arguments: arguments.join(" "),
            message: "commit failed".to_owned(),
        }),
        _ => run_store_git(root, arguments),
    }
}

#[test]
fn a_claim_and_a_release_whose_commit_fails_keep_their_fact_save_the_problem_and_push_nothing() {
    let (directory, store) = store_with_slice();
    let head = git_text(directory.path(), &["rev-parse", "HEAD"]);
    let effects = ClaimEffects {
        sync: SyncEffects {
            read_origin: origin,
            run_network_git: recorded_network,
            run_git: git_with_a_failing_commit,
            ..SyncEffects::system()
        },
        ..ClaimEffects::system()
    };
    NETWORK.set(Vec::new());

    let claimed = claim_slice(&store, &slice(), &manager(), &effects).expect("the claim works");
    let saved = saved_result(&directory);
    let released =
        release_slice(&store, &slice(), &manager(), &effects).expect("the release works");

    for (name, sync) in [("claim", &claimed.sync), ("release", &released.sync)] {
        assert!(!sync.committed && !sync.pushed, "{name}: {sync:?}");
        assert_eq!(sync.problems.len(), 1, "{name}: {sync:?}");
        assert_eq!(sync.problems[0].step, SyncStep::Commit, "{name}");
    }
    assert_eq!(saved["problems"][0]["step"], serde_json::json!("commit"));
    assert_eq!(
        saved_result(&directory)["problems"][0]["step"],
        serde_json::json!("commit")
    );
    assert_eq!(
        NETWORK.take(),
        ["fetch --quiet --no-tags --prune origin"; 2],
        "nothing is pushed"
    );
    let facts = read_facts(directory.path())
        .expect("the facts are read")
        .facts;
    let kinds: Vec<&str> = facts
        .iter()
        .map(|fact| match fact.event {
            FactEvent::Claim(_) => "claim",
            FactEvent::Release { .. } => "release",
            FactEvent::Pr(_) => "pr",
            FactEvent::Audit(_) => "audit",
            FactEvent::Question { .. } => "question",
            FactEvent::Answer { .. } => "answer",
        })
        .collect();
    assert_eq!(kinds, ["claim", "release"], "both facts stay");
    assert_eq!(git_text(directory.path(), &["rev-parse", "HEAD"]), head);
    assert_eq!(
        git_text(directory.path(), &["diff", "--cached", "--name-only"]),
        ""
    );
}
