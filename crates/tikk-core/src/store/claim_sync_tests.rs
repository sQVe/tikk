use std::cell::Cell;
use std::fs;
use std::path::Path;

use tempfile::TempDir;

use crate::fact::AgentName;
use crate::store::git::run_store_git;
use crate::store::identity::Identity;
use crate::store::sync::{FileEntry, FileKind, SyncEffects, SyncStep};
use crate::store::sync_read::read_entry;
use crate::store::ticket_claim::{ClaimEffects, claim_slice};
use crate::store::{MachineName, Store, StoreEffects, StoreError, init};
use crate::ticket::TicketId;

const FETCHED: &str = "1111111111111111111111111111111111111111";

thread_local! {
    static MERGE_STARTED: Cell<bool> = const { Cell::new(false) };
    static ABORT_FAILS: Cell<bool> = const { Cell::new(false) };
    static HEAD_STAYS: Cell<bool> = const { Cell::new(false) };
}

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

/// Real Git, except that `origin/main` has one new commit and every merge fails. `ABORT_FAILS` makes
/// the abort fail, and `HEAD_STAYS` leaves `MERGE_HEAD` after the abort.
fn git_with_a_failing_merge(root: &Path, arguments: &[&str]) -> Result<Vec<u8>, StoreError> {
    match arguments {
        ["for-each-ref", ..] => Ok(FETCHED.as_bytes().to_vec()),
        ["rev-list", ..] => Ok(b"1\n".to_vec()),
        ["merge", "--abort"] if ABORT_FAILS.get() => Err(failed(arguments)),
        ["merge", "--abort"] => {
            MERGE_STARTED.set(HEAD_STAYS.get());

            Ok(Vec::new())
        }
        ["merge", ..] => {
            MERGE_STARTED.set(ABORT_FAILS.get() || HEAD_STAYS.get());

            Err(failed(arguments))
        }
        _ => run_store_git(root, arguments),
    }
}

/// `MERGE_HEAD` exists from the failed merge until its abort.
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

    let result = claim_slice(&store, &slice(), &manager(), &effects());

    assert!(
        matches!(&result, Err(StoreError::MergeInProgress { .. })),
        "{result:?}"
    );
    assert!(!directory.path().join("facts").exists());
}
