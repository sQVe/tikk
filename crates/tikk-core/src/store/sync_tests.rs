use std::cell::{Cell, RefCell};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tempfile::TempDir;

use super::{PendingFile, PendingReason, SyncEffects, SyncOutcome, SyncStep, sync_store};
use crate::store::git::{read_store_origin, run_store_git};
use crate::store::sync_read::read_entry;
use crate::store::{
    FileEntry, IdClash, MachineName, RemoteInitEffects, StoreError, init_from_remote, open,
};
use crate::ticket::TicketId;

const TICKET: &str = "tickets/personal/personal-abcd-renew.md";
const TICKET_TEXT: &str = "---\nkind: task\ntitle: Renew the domain\n---\n";
const FACT: &str = "facts/laptop/2026-11.jsonl";
const FACT_LINE: &str = "{\"v\":1,\"kind\":\"release\",\"ticket\":\"personal-abcd\",\"at\":\"2026-11-13T01:00:00Z\",\"agent\":null}\n";
const GIT_READS: &[&str] = &[
    "symbolic-ref",
    "rev-parse",
    "rev-list",
    "status",
    "for-each-ref",
    "cat-file",
    "diff",
];

thread_local! {
    static READS: Cell<usize> = const { Cell::new(0) };
    static FAIL_READ: Cell<Option<usize>> = const { Cell::new(None) };
    static INJECTED: Cell<bool> = const { Cell::new(false) };
    static FAIL_GIT: RefCell<Vec<&'static str>> = const { RefCell::new(Vec::new()) };
    static CLOCK: Cell<Option<SystemTime>> = const { Cell::new(None) };
    static WAITED: Cell<Duration> = const { Cell::new(Duration::ZERO) };
    static NETWORK: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    static CHECKED: RefCell<Option<(PathBuf, Vec<u8>)>> = const { RefCell::new(None) };
}

struct Machines {
    _remote: TempDir,
    laptop: TempDir,
    desktop: TempDir,
}

impl Machines {
    fn new() -> Self {
        let remote = tempfile::tempdir().expect("create the remote folder");
        run_store_git(
            remote.path(),
            &["init", "--quiet", "--bare", "--initial-branch=main"],
        )
        .expect("create the bare remote");
        let url = remote.path().to_str().expect("a UTF-8 path").to_owned();
        let clone = |machine: &str| {
            let folder = tempfile::tempdir().expect("create a store folder");
            init_from_remote(
                &folder.path().join("store"),
                &url,
                Some(MachineName::parse(machine).expect("a valid machine name")),
                &RemoteInitEffects::system(),
            )
            .expect("init from the remote");

            folder
        };
        let laptop = clone("laptop");
        let desktop = clone("desktop");

        Self {
            _remote: remote,
            laptop,
            desktop,
        }
    }

    fn laptop(&self) -> PathBuf {
        self.laptop.path().join("store")
    }

    fn desktop(&self) -> PathBuf {
        self.desktop.path().join("store")
    }
}

fn write(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().expect("a store file has a folder"))
        .expect("create the folder");
    fs::write(path, text).expect("write a store file");
}

fn git(root: &Path, arguments: &[&str]) -> String {
    String::from_utf8(run_store_git(root, arguments).expect("git runs")).expect("UTF-8 output")
}

fn snapshot(root: &Path) -> (String, String, Vec<(PathBuf, Vec<u8>)>, bool) {
    let mut files = Vec::new();
    collect(root, root, &mut files);
    files.sort();

    (
        git(root, &["rev-parse", "HEAD"]),
        git(root, &["ls-files", "--stage"]),
        files,
        root.join(".git/MERGE_HEAD").exists(),
    )
}

fn collect(root: &Path, folder: &Path, files: &mut Vec<(PathBuf, Vec<u8>)>) {
    for entry in fs::read_dir(folder).expect("list a folder") {
        let path = entry.expect("read an entry").path();

        if path.ends_with(".git") {
            continue;
        }

        if path.is_dir() {
            collect(root, &path, files);
        } else {
            let relative = path
                .strip_prefix(root)
                .expect("inside the store")
                .to_owned();
            files.push((relative, fs::read(&path).expect("read a file")));
        }
    }
}

fn count_read() -> Result<(), StoreError> {
    let read = READS.get();

    READS.set(read + 1);

    if FAIL_READ.get() == Some(read) {
        INJECTED.set(true);

        return Err(StoreError::Git {
            arguments: "injected".to_owned(),
            message: format!("read {read} failed"),
        });
    }

    Ok(())
}

fn fake_git(directory: &Path, arguments: &[&str]) -> Result<Vec<u8>, StoreError> {
    let command = arguments.first().copied().unwrap_or_default();
    let joined = arguments.join(" ");

    if FAIL_GIT.with_borrow(|failing| failing.iter().any(|prefix| joined.starts_with(prefix))) {
        return Err(StoreError::Git {
            arguments: joined,
            message: "injected".to_owned(),
        });
    }

    if GIT_READS.contains(&command) {
        count_read()?;
    }

    run_store_git(directory, arguments)
}

fn fake_entry(path: &Path) -> Result<Option<FileEntry>, StoreError> {
    count_read()?;

    let checked = CHECKED.with_borrow(|checked| {
        checked
            .as_ref()
            .filter(|(checked_path, _)| path.ends_with(checked_path))
            .map(|(_, bytes)| bytes.clone())
    });
    let entry = read_entry(path)?;

    Ok(match checked {
        Some(bytes) => entry.map(|entry| FileEntry { bytes, ..entry }),
        None => entry,
    })
}

// The preflight also reads `MERGE_HEAD`. Only the read after a failed merge finds the file.
fn entry_failing_on_merge_head(path: &Path) -> Result<Option<FileEntry>, StoreError> {
    if path.ends_with(".git/MERGE_HEAD") && path.exists() {
        return Err(StoreError::Git {
            arguments: "read MERGE_HEAD".to_owned(),
            message: "injected".to_owned(),
        });
    }

    fake_entry(path)
}

fn fake_origin(root: &Path) -> Result<Option<String>, StoreError> {
    count_read()?;

    read_store_origin(root)
}

fn fake_network(directory: &Path, arguments: &[&str]) -> Result<Vec<u8>, StoreError> {
    let joined = arguments.join(" ");

    NETWORK.with_borrow_mut(|calls| calls.push(joined.clone()));

    if FAIL_GIT.with_borrow(|failing| failing.iter().any(|prefix| joined.starts_with(prefix))) {
        return Err(StoreError::GitTimeout {
            arguments: joined,
            timeout: Duration::from_secs(30),
        });
    }

    run_store_git(directory, arguments)
}

fn fake_now() -> SystemTime {
    CLOCK.get().unwrap_or_else(SystemTime::now)
}

fn advancing_wait(duration: Duration) {
    WAITED.set(WAITED.get() + duration);
    CLOCK.set(Some(fake_now() + duration));
}

fn no_wait(duration: Duration) {
    WAITED.set(WAITED.get() + duration);
}

fn effects() -> SyncEffects {
    SyncEffects {
        run_git: fake_git,
        run_network_git: fake_network,
        read_origin: fake_origin,
        read_entry: fake_entry,
        now: fake_now,
        wait: advancing_wait,
        ..SyncEffects::system()
    }
}

fn later() -> Option<SystemTime> {
    Some(SystemTime::now() + Duration::from_secs(3600))
}

fn sync(root: &Path, effects: &SyncEffects) -> Result<SyncOutcome, StoreError> {
    sync_store(&open(root).expect("the store opens"), effects)
}

fn machines_with_work() -> Machines {
    let machines = Machines::new();
    let (laptop, desktop) = (machines.laptop(), machines.desktop());
    CLOCK.set(later());
    write(&laptop, TICKET, TICKET_TEXT);
    write(&laptop, FACT, FACT_LINE);
    sync(&laptop, &effects()).expect("the laptop syncs");
    sync(&desktop, &effects()).expect("the desktop syncs");
    write(
        &laptop,
        "tickets/personal/personal-efgh-mail.md",
        TICKET_TEXT,
    );
    sync(&laptop, &effects()).expect("the laptop syncs again");

    machines
}

#[test]
fn each_read_that_fails_stops_sync_before_it_changes_anything() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    write(
        &desktop,
        "tickets/personal/personal-wxyz-new.md",
        TICKET_TEXT,
    );
    write(
        &desktop,
        "tickets/personal/personal-abcd/design.md",
        "notes\n",
    );
    write(&desktop, FACT, &format!("{FACT_LINE}{FACT_LINE}"));
    fs::remove_file(desktop.join(TICKET)).expect("delete a ticket by hand");
    let before = snapshot(&desktop);
    let mut failed = 0;

    loop {
        READS.set(0);
        INJECTED.set(false);
        FAIL_READ.set(Some(failed));

        let result = sync(&desktop, &effects());

        if !INJECTED.get() {
            let outcome = result.expect("sync succeeds when no read fails");
            assert!(outcome.committed && outcome.merged, "{outcome:?}");
            break;
        }

        assert!(
            matches!(&result, Err(StoreError::Git { arguments, .. }) if arguments == "injected"),
            "read {failed}: {result:?}"
        );
        assert_eq!(snapshot(&desktop), before, "read {failed}");
        failed += 1;
    }

    assert!(failed >= 12, "only {failed} reads were failed");
}

#[test]
fn a_failed_read_of_the_conflicts_still_aborts_the_merge_and_reports_both_errors() {
    let machines = Machines::new();
    let (laptop, desktop) = (machines.laptop(), machines.desktop());
    CLOCK.set(later());
    write(&laptop, TICKET, TICKET_TEXT);
    sync(&laptop, &effects()).expect("the laptop syncs");
    sync(&desktop, &effects()).expect("the desktop syncs");
    write(&laptop, TICKET, "---\nkind: task\ntitle: One year\n---\n");
    sync(&laptop, &effects()).expect("the laptop pushes its edit");
    let local = "---\nkind: task\ntitle: Two years\n---\n";
    write(&desktop, TICKET, local);
    NETWORK.set(Vec::new());
    FAIL_GIT.set(vec!["diff --name-only"]);

    let error = sync(&desktop, &effects()).expect_err("the conflict list cannot be read");

    assert!(
        matches!(&error, StoreError::ConflictsUnreadable { merge, read }
            if matches!(**merge, StoreError::Git { ref arguments, .. } if arguments.starts_with("merge"))
                && matches!(**read, StoreError::Git { ref arguments, .. } if arguments.starts_with("diff"))),
        "{error:?}"
    );
    assert!(!desktop.join(".git/MERGE_HEAD").exists());
    assert_eq!(
        fs::read_to_string(desktop.join(TICKET)).expect("read the ticket"),
        local
    );
    assert!(NETWORK.with_borrow(|calls| !calls.iter().any(|call| call.starts_with("push"))));
}

#[test]
fn a_failed_read_of_merge_head_still_aborts_the_merge_and_reports_both_errors() {
    let machines = Machines::new();
    let (laptop, desktop) = (machines.laptop(), machines.desktop());
    CLOCK.set(later());
    write(&laptop, TICKET, TICKET_TEXT);
    sync(&laptop, &effects()).expect("the laptop syncs");
    sync(&desktop, &effects()).expect("the desktop syncs");
    write(&laptop, TICKET, "---\nkind: task\ntitle: One year\n---\n");
    sync(&laptop, &effects()).expect("the laptop pushes its edit");
    let local = "---\nkind: task\ntitle: Two years\n---\n";
    write(&desktop, TICKET, local);
    NETWORK.set(Vec::new());
    let failing = SyncEffects {
        read_entry: entry_failing_on_merge_head,
        ..effects()
    };

    let error = sync(&desktop, &failing).expect_err("MERGE_HEAD cannot be read");

    assert!(
        matches!(&error, StoreError::ConflictsUnreadable { merge, read }
            if matches!(**merge, StoreError::Git { ref arguments, .. } if arguments.starts_with("merge"))
                && matches!(**read, StoreError::Git { ref arguments, .. } if arguments == "read MERGE_HEAD")),
        "{error:?}"
    );
    assert!(!desktop.join(".git/MERGE_HEAD").exists());
    assert_eq!(
        fs::read_to_string(desktop.join(TICKET)).expect("read the ticket"),
        local
    );
    assert!(NETWORK.with_borrow(|calls| !calls.iter().any(|call| call.starts_with("push"))));
}

#[test]
fn a_failed_abort_after_a_conflict_names_the_conflict_and_the_abort() {
    let machines = Machines::new();
    let (laptop, desktop) = (machines.laptop(), machines.desktop());
    CLOCK.set(later());
    write(&laptop, TICKET, TICKET_TEXT);
    sync(&laptop, &effects()).expect("the laptop syncs");
    sync(&desktop, &effects()).expect("the desktop syncs");
    write(&laptop, TICKET, "---\nkind: task\ntitle: One year\n---\n");
    sync(&laptop, &effects()).expect("the laptop pushes its edit");
    write(&desktop, TICKET, "---\nkind: task\ntitle: Two years\n---\n");
    FAIL_GIT.set(vec!["merge --abort"]);

    let error = sync(&desktop, &effects()).expect_err("the abort fails");

    assert!(
        matches!(&error, StoreError::MergeAbortFailed { cause, .. }
            if matches!(**cause, StoreError::Conflict { ref files, .. } if *files == [PathBuf::from(TICKET)])),
        "{error:?}"
    );
}

#[test]
fn a_fetch_that_times_out_still_commits_and_skips_the_merge_and_the_push() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    write(
        &desktop,
        "tickets/personal/personal-wxyz-new.md",
        TICKET_TEXT,
    );
    let head = git(&desktop, &["rev-parse", "HEAD"]);
    NETWORK.set(Vec::new());
    FAIL_GIT.set(vec!["fetch"]);

    let outcome = sync(&desktop, &effects()).expect("a network failure is a result");

    assert!(outcome.committed, "{outcome:?}");
    assert!(
        !outcome.fetched && !outcome.merged && !outcome.pushed,
        "{outcome:?}"
    );
    assert_eq!(outcome.problems.len(), 1);
    assert_eq!(outcome.problems[0].step, SyncStep::Fetch);
    assert!(
        outcome.problems[0].message.contains("did not finish"),
        "{outcome:?}"
    );
    assert_eq!(NETWORK.take(), ["fetch --quiet --no-tags --prune origin"]);
    assert_eq!(
        git(&desktop, &["rev-parse", "HEAD~1"]),
        head,
        "the commit sits on the old HEAD, with no merge"
    );
}

#[test]
fn a_failed_push_is_a_problem_and_the_next_sync_pushes() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    write(
        &desktop,
        "tickets/personal/personal-wxyz-new.md",
        TICKET_TEXT,
    );
    FAIL_GIT.set(vec!["push"]);

    let failed = sync(&desktop, &effects()).expect("a network failure is a result");
    FAIL_GIT.set(Vec::new());
    let next = sync(&desktop, &effects()).expect("the next sync runs");

    assert!(
        failed.committed && failed.merged && !failed.pushed,
        "{failed:?}"
    );
    assert_eq!(failed.problems[0].step, SyncStep::Push);
    assert!(!next.committed && !next.merged && next.pushed, "{next:?}");
    assert_eq!(
        git(&machines.laptop(), &["ls-remote", "origin", "main"])
            .split('\t')
            .next(),
        Some(git(&desktop, &["rev-parse", "HEAD"]).trim())
    );
}

#[test]
fn a_young_file_is_committed_after_sync_waits_for_it_to_settle() {
    let machines = Machines::new();
    let laptop = machines.laptop();
    write(&laptop, TICKET, TICKET_TEXT);
    CLOCK.set(Some(SystemTime::now()));
    WAITED.set(Duration::ZERO);

    let outcome = sync(&laptop, &effects()).expect("sync runs");

    assert_eq!(outcome.committed_paths, [TICKET]);
    assert!(
        WAITED.get() > Duration::from_millis(1500),
        "{:?}",
        WAITED.get()
    );
    assert!(WAITED.get() <= Duration::from_secs(2), "{:?}", WAITED.get());
}

#[test]
fn a_file_still_young_after_the_wait_stays_pending_as_settling() {
    let machines = Machines::new();
    let laptop = machines.laptop();
    write(&laptop, TICKET, TICKET_TEXT);
    write(&laptop, FACT, FACT_LINE);
    CLOCK.set(Some(SystemTime::now()));
    let effects = SyncEffects {
        wait: no_wait,
        ..effects()
    };

    let outcome = sync(&laptop, &effects).expect("sync runs");

    assert_eq!(outcome.committed_paths, [FACT], "facts never wait");
    assert_eq!(
        outcome.pending,
        [PendingFile {
            path: TICKET.to_owned(),
            reason: PendingReason::Settling
        }]
    );
}

#[test]
fn sync_stages_the_bytes_it_checked_not_a_later_read_of_the_file() {
    let machines = Machines::new();
    let laptop = machines.laptop();
    write(
        &laptop,
        TICKET,
        "---\nkind: task\ntitle: Saved later\n---\n",
    );
    CLOCK.set(later());
    CHECKED.set(Some((
        PathBuf::from(TICKET),
        TICKET_TEXT.as_bytes().to_vec(),
    )));

    sync(&laptop, &effects()).expect("sync runs");

    assert_eq!(
        git(&laptop, &["show", &format!("HEAD:{TICKET}")]),
        TICKET_TEXT
    );
    assert_eq!(
        git(&laptop, &["status", "--porcelain"]),
        format!(" M {TICKET}\n")
    );
}

#[test]
fn a_pending_file_that_blocks_the_merge_is_refused_and_nothing_is_pushed() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    let broken = "---\nkind: [\n---\n";
    write(&desktop, "tickets/personal/personal-efgh-mail.md", broken);
    NETWORK.set(Vec::new());

    let error = sync(&desktop, &effects()).expect_err("Git refuses the merge");

    assert!(
        matches!(&error, StoreError::MergeBlocked { message } if message.contains("would be overwritten by merge")),
        "{error:?}"
    );
    assert!(!desktop.join(".git/MERGE_HEAD").exists());
    assert_eq!(
        fs::read_to_string(desktop.join("tickets/personal/personal-efgh-mail.md"))
            .expect("read the pending file"),
        broken
    );
    assert!(NETWORK.with_borrow(|calls| !calls.iter().any(|call| call.starts_with("push"))));
}

#[test]
fn sync_refuses_a_store_in_a_merge_or_with_staged_changes_and_changes_nothing() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    write(
        &desktop,
        "tickets/personal/personal-wxyz-new.md",
        TICKET_TEXT,
    );
    write(&desktop, "notes.txt", "mine\n");
    git(&desktop, &["add", "notes.txt"]);
    let staged = snapshot(&desktop);

    let refused = sync(&desktop, &effects()).expect_err("a staged file is refused");

    assert!(
        matches!(&refused, StoreError::StagedChanges { paths, .. } if *paths == [PathBuf::from("notes.txt")]),
        "{refused:?}"
    );
    assert_eq!(snapshot(&desktop), staged);
    git(&desktop, &["rm", "--cached", "--quiet", "notes.txt"]);
    fs::write(desktop.join(".git/MERGE_HEAD"), "0000\n").expect("leave a merge in progress");
    let merging = snapshot(&desktop);

    let refused = sync(&desktop, &effects()).expect_err("a merge in progress is refused");

    assert!(
        matches!(refused, StoreError::MergeInProgress { .. }),
        "{refused:?}"
    );
    assert_eq!(snapshot(&desktop), merging);
}

#[test]
fn a_deleted_fact_file_makes_sync_refuse_and_change_nothing() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    fs::remove_file(desktop.join(FACT)).expect("delete the fact file");
    let before = snapshot(&desktop);

    let error = sync(&desktop, &effects()).expect_err("a deleted fact file is refused");

    assert!(
        matches!(&error, StoreError::FactRewritten { path } if path.ends_with(FACT)),
        "{error:?}"
    );
    assert_eq!(snapshot(&desktop), before);
}

#[test]
fn a_conflict_is_saved_as_the_last_result() {
    let machines = Machines::new();
    let (laptop, desktop) = (machines.laptop(), machines.desktop());
    CLOCK.set(later());
    write(&laptop, TICKET, TICKET_TEXT);
    sync(&laptop, &effects()).expect("the laptop syncs");
    sync(&desktop, &effects()).expect("the desktop syncs");
    write(&laptop, TICKET, "---\nkind: task\ntitle: One year\n---\n");
    sync(&laptop, &effects()).expect("the laptop pushes its edit");
    write(&desktop, TICKET, "---\nkind: task\ntitle: Two years\n---\n");

    let error = sync(&desktop, &effects()).expect_err("the edits conflict");

    assert!(matches!(error, StoreError::Conflict { .. }), "{error:?}");
    let saved: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(desktop.join(".git/tikk-sync.json")).expect("read the saved result"),
    )
    .expect("the saved result is JSON");
    assert_eq!(saved["conflict"], serde_json::json!([TICKET]));
    assert_eq!(saved["error"], serde_json::json!(error.to_string()));
}

#[test]
fn a_result_that_cannot_be_saved_is_a_problem_or_joins_the_error() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    let result_file = desktop.join(".git/tikk-sync.json");
    fs::remove_file(&result_file).expect("remove the earlier result");
    fs::create_dir_all(result_file.join("held")).expect("block the result file with a folder");

    let outcome = sync(&desktop, &effects()).expect("the sync itself works");
    write(&desktop, "notes.txt", "mine\n");
    git(&desktop, &["add", "notes.txt"]);
    let error = sync(&desktop, &effects()).expect_err("a staged file is refused");

    assert!(outcome.merged, "{outcome:?}");
    assert_eq!(
        outcome.problems.last().map(|problem| problem.step),
        Some(SyncStep::Save)
    );
    assert!(
        matches!(&error, StoreError::ResultNotSaved { error, save }
            if matches!(**error, StoreError::StagedChanges { .. })
                && matches!(**save, StoreError::Io { action: "replace", .. })),
        "{error:?}"
    );
}

#[test]
fn a_deleted_ticket_is_committed_as_a_deletion() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    fs::remove_file(desktop.join(TICKET)).expect("delete a ticket by hand");

    let outcome = sync(&desktop, &effects()).expect("sync runs");

    assert!(
        outcome.committed_paths.contains(&TICKET.to_owned()),
        "{outcome:?}"
    );
    assert_eq!(
        git(&desktop, &["ls-tree", "--name-only", "HEAD", "--", TICKET]),
        ""
    );
    assert_eq!(git(&desktop, &["status", "--porcelain"]), "");
}

#[test]
fn a_store_on_another_branch_is_refused_and_nothing_changes() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    git(&desktop, &["switch", "--quiet", "--create", "work"]);
    write(
        &desktop,
        "tickets/personal/personal-wxyz-new.md",
        TICKET_TEXT,
    );
    let before = snapshot(&desktop);

    let error = sync(&desktop, &effects()).expect_err("a store off main is refused");

    assert!(
        matches!(&error, StoreError::NotOnMain { branch, .. } if branch == "refs/heads/work"),
        "{error:?}"
    );
    assert_eq!(snapshot(&desktop), before);
}

#[test]
fn a_fact_line_changed_in_place_makes_sync_refuse_and_change_nothing() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    write(
        &desktop,
        FACT,
        &FACT_LINE.replace("personal-abcd", "personal-zzzz"),
    );
    let before = snapshot(&desktop);

    let error = sync(&desktop, &effects()).expect_err("a rewritten line is refused");

    assert!(
        matches!(&error, StoreError::FactRewritten { path } if path.ends_with(FACT)),
        "{error:?}"
    );
    assert_eq!(snapshot(&desktop), before);
}

#[test]
fn the_outcome_names_each_reason_and_step_in_camel_case() {
    let pending = |path: &str, reason| PendingFile {
        path: path.to_owned(),
        reason,
    };
    let problem = |step| super::SyncProblem::new(step, "failed".to_owned());
    let outcome = SyncOutcome {
        committed: false,
        committed_paths: Vec::new(),
        pending: vec![
            pending("a", PendingReason::Settling),
            pending("b", PendingReason::Unparsed),
            pending("c", PendingReason::NameNotUtf8),
        ],
        fetched: false,
        merged: false,
        pushed: false,
        problems: vec![
            problem(SyncStep::Fetch),
            super::SyncProblem {
                files: vec!["d".to_owned()],
                ..problem(SyncStep::Merge)
            },
            problem(SyncStep::Commit),
            problem(SyncStep::Push),
            problem(SyncStep::Save),
        ],
        clashes: vec![IdClash {
            id: TicketId::parse("personal-abcd").expect("a valid ID"),
            paths: vec![PathBuf::from("e"), PathBuf::from("f")],
        }],
    };

    let json = serde_json::to_value(&outcome).expect("the outcome serializes");

    assert_eq!(
        json["pending"],
        serde_json::json!([
            { "path": "a", "reason": "settling" },
            { "path": "b", "reason": "unparsed" },
            { "path": "c", "reason": "nameNotUtf8" },
        ])
    );
    assert_eq!(
        json["problems"],
        serde_json::json!([
            { "step": "fetch", "message": "failed" },
            { "step": "merge", "message": "failed", "files": ["d"] },
            { "step": "commit", "message": "failed" },
            { "step": "push", "message": "failed" },
            { "step": "save", "message": "failed" },
        ])
    );
    assert_eq!(
        json["clashes"],
        serde_json::json!([{ "id": "personal-abcd", "paths": ["e", "f"] }])
    );
}

#[test]
fn a_failed_commit_unstages_what_sync_staged_and_the_next_sync_works() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    write(
        &desktop,
        "tickets/personal/personal-wxyz-new.md",
        TICKET_TEXT,
    );
    fs::remove_file(desktop.join(TICKET)).expect("delete a ticket by hand");
    let before = snapshot(&desktop);
    FAIL_GIT.set(vec!["commit"]);

    let error = sync(&desktop, &effects()).expect_err("the commit fails");
    let after_failure = snapshot(&desktop);
    FAIL_GIT.set(Vec::new());
    let next = sync(&desktop, &effects());

    assert!(
        matches!(&error, StoreError::Git { arguments, .. } if arguments.starts_with("commit")),
        "{error:?}"
    );
    assert_eq!(after_failure, before);
    let next = next.expect("the next sync works with no reset by hand");
    assert!(next.committed && next.merged, "{next:?}");
}

#[test]
fn a_failed_unstage_after_a_failed_commit_reports_both_errors() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    write(
        &desktop,
        "tickets/personal/personal-wxyz-new.md",
        TICKET_TEXT,
    );
    FAIL_GIT.set(vec!["commit", "--literal-pathspecs reset"]);

    let error = sync(&desktop, &effects()).expect_err("the commit and the unstage fail");

    assert!(
        matches!(&error, StoreError::UnstageFailed { cause, unstage, .. }
            if matches!(**cause, StoreError::Git { ref arguments, .. } if arguments.starts_with("commit"))
                && matches!(**unstage, StoreError::Git { ref arguments, .. } if arguments.starts_with("--literal-pathspecs reset"))),
        "{error:?}"
    );
}
