use std::cell::{Cell, RefCell};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tempfile::TempDir;

use super::{SyncEffects, SyncOutcome, sync_store};
use crate::store::git::{read_store_origin, run_store_git};
use crate::store::sync_read::read_entry;
use crate::store::test_support::sync_remote::{
    bare_remote, git_text, store_files, store_on_remote,
};
use crate::store::{FileEntry, StoreError, open};

#[path = "sync_commit_tests.rs"]
mod commit_tests;
#[path = "sync_merge_tests.rs"]
mod merge_tests;
#[path = "sync_network_tests.rs"]
mod network_tests;
#[path = "sync_refusal_tests.rs"]
mod refusal_tests;
#[path = "sync_result_tests.rs"]
mod result_tests;

const TICKET: &str = "tickets/personal/personal-abcd-renew.md";

const TICKET_TEXT: &str = "---\nkind: task\ntitle: Renew the domain\n---\n";

const FACT: &str = "facts/laptop/2026-11.jsonl";

const FACT_LINE: &str = "{\"v\":1,\"kind\":\"release\",\"ticket\":\"personal-abcd\",\"at\":\"2026-11-13T01:00:00Z\",\"agent\":null}\n";

const LOCAL_EDIT: &str = "---\nkind: task\ntitle: Two years\n---\n";

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
        let remote = bare_remote();
        let laptop = store_on_remote(remote.path(), "laptop");
        let desktop = store_on_remote(remote.path(), "desktop");

        Self {
            _remote: remote,
            laptop,
            desktop,
        }
    }

    fn laptop(&self) -> PathBuf {
        self.laptop.path().to_path_buf()
    }

    fn desktop(&self) -> PathBuf {
        self.desktop.path().to_path_buf()
    }
}

fn write(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().expect("a store file has a folder"))
        .expect("create the folder");
    fs::write(path, text).expect("write a store file");
}

fn snapshot(root: &Path) -> (String, String, Vec<(PathBuf, Vec<u8>)>, bool) {
    (
        git_text(root, &["rev-parse", "HEAD"]),
        git_text(root, &["ls-files", "--stage"]),
        store_files(root),
        root.join(".git/MERGE_HEAD").exists(),
    )
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

// The laptop pushed an edit of the ticket, and the desktop holds its own edit of it, unsynced.
fn machines_in_conflict() -> Machines {
    let machines = Machines::new();
    let (laptop, desktop) = (machines.laptop(), machines.desktop());
    CLOCK.set(later());
    write(&laptop, TICKET, TICKET_TEXT);
    sync(&laptop, &effects()).expect("the laptop syncs");
    sync(&desktop, &effects()).expect("the desktop syncs");
    write(&laptop, TICKET, "---\nkind: task\ntitle: One year\n---\n");
    sync(&laptop, &effects()).expect("the laptop pushes its edit");
    write(&desktop, TICKET, LOCAL_EDIT);

    machines
}

fn dangling_ticket_link(root: &Path) {
    std::os::unix::fs::symlink(
        "missing.md",
        root.join("tickets/personal/personal-zzzz-link.md"),
    )
    .expect("leave a dangling ticket symlink");
}
