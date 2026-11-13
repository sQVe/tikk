mod attention_read;
mod audit;
mod audit_check;
mod claim_lease;
mod claim_sync;
mod derived_state;
mod fact_files;
mod git;
mod id_clash;
mod identity;
mod machine;
mod pr_github;
mod pr_link;
mod pr_refresh;
mod process_run;
mod project_choice;
mod question_answer;
mod question_ask;
mod ready;
mod store_init;
mod store_init_remote;
mod store_lock;
mod sync;
mod sync_commit;
mod sync_merge;
mod sync_read;
mod sync_result;
mod system;
mod ticket_claim;
mod ticket_create;
mod ticket_edit;
mod ticket_file_write;
mod ticket_files;
mod ticket_id_draw;
mod ticket_link_checks;
mod ticket_new_file;
mod ticket_queries;
mod ticket_rank;
mod ticket_relations;
mod ticket_status;
mod ticket_write;

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use thiserror::Error;

pub use attention_read::{AttentionEffects, read_attention};
pub use audit::{AuditEffects, AuditRequest, audit_slice};
pub use audit_check::{AuditCheck, AuditReason};
pub use claim_lease::LeaseEffects;
pub use claim_sync::Synced;
pub use derived_state::{DerivedStates, DerivedStatus};
pub use fact_files::UnreadableFact;
pub use id_clash::IdClash;
pub use identity::Identity;
pub use machine::MachineName;
pub use pr_github::PrFailure;
pub use pr_link::{PrEffects, link_pr};
pub use pr_refresh::{RefreshOutcome, RefreshedPr, refresh_prs};
pub use question_answer::{AnswerEffects, answer_question};
pub use question_ask::{AskEffects, ask_question};
pub use ready::{
    BlockerState, Hold, ReadyEffects, ReadyQueue, ReadyScope, ReadySlice, SkippedSlice,
    StackParent, ready_slices,
};
pub use store_init::{InitOutcome, init};
pub use store_init_remote::{RemoteInitEffects, init_from_remote};
pub use store_lock::{LockAccess, StoreLock};
pub use sync::{
    FileEntry, FileKind, PendingFile, PendingReason, SyncEffects, SyncOutcome, SyncProblem,
    SyncStep, sync_store,
};
pub use ticket_claim::{ClaimEffects, ShownClaim, claim_slice, release_slice};
pub use ticket_create::{NewTicket, NewTicketSource, TicketEffects, create_ticket};
pub use ticket_edit::{EditEffects, edit_ticket};
pub use ticket_files::{StoredTicket, UnreadableTicket};
pub use ticket_link_checks::{WaitLink, WaitStep};
pub use ticket_queries::{
    QueryEffects, ShownTicket, TicketFilter, TicketListing, list_tickets, show_ticket,
};
pub use ticket_rank::{RankPlace, rank_ticket};
pub use ticket_relations::{block_ticket, move_ticket, unblock_ticket};
pub use ticket_status::{cancel_ticket, mark_done};
pub use ticket_write::{TicketWrite, WriteEffects, write_ticket};

use crate::ticket::{Kind, TicketError};

const CONFIG_FILE: &str = "tikk.json";
const STORE_UNDER_HOME: &str = ".local/share/tikk";

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("No tikk store at {}. Run `tikk init` first.", store.display())]
    NotInitialized { store: PathBuf },
    #[error("{} holds files but no tikk store.", store.display())]
    FolderNotEmpty { store: PathBuf },
    #[error("{} is not a tikk config with version 1.", path.display())]
    InvalidConfig { path: PathBuf },
    #[error("{}/.git is not the store's own Git repository.", store.display())]
    ForeignRepository { store: PathBuf },
    #[error("Neither TIKK_HOME nor HOME is set, so the store has no path.")]
    NoStorePath,
    #[error("`{name}` is not a machine name: {reason}.")]
    InvalidMachineName { name: String, reason: &'static str },
    #[error("The host name `{host_name}` gives no machine name. Pass --machine.")]
    InvalidHostName { host_name: String },
    #[error("Could not read the host name: {message}. Pass --machine.")]
    HostNameUnavailable { message: String },
    #[error("`git {arguments}` failed: {message}")]
    Git { arguments: String, message: String },
    #[error(transparent)]
    Ticket(#[from] TicketError),
    #[error("{} is not a valid ticket file: {message}", path.display())]
    TicketParse { path: PathBuf, message: String },
    #[error("No ticket has the ID {id}.")]
    NotFound { id: String },
    #[error("{} files share the ID {id}. Rename all but one.", paths.len())]
    IdShared { id: String, paths: Vec<PathBuf> },
    #[error("The repository name in the origin URL `{url}` is not a project name. Pass --project.")]
    InvalidOrigin { url: String },
    #[error("Found no free ID in the project {project}.")]
    NoFreeId { project: String },
    #[error("Could not read random bytes: {message}")]
    RandomUnavailable { message: String },
    #[error("Another process held the store lock {} for too long. Try again.", lock.display())]
    Locked { lock: PathBuf },
    #[error("{} changed after it was read. Run `tikk show` again and redo the change.", path.display())]
    ChangedOnDisk { path: PathBuf },
    #[error("{id} is a {kind}, but this command takes {allowed}.")]
    WrongKind {
        id: String,
        kind: Kind,
        allowed: &'static str,
    },
    #[error("`{field}` would make a cycle: {}.", describe_cycle(steps))]
    Cycle {
        field: &'static str,
        steps: Vec<WaitStep>,
    },
    #[error("{anchor} is not a sibling of {id}. Pass a ticket with the same parent.")]
    NotSibling { id: String, anchor: String },
    #[error("EDITOR names no program. Set it to the editor to start, such as `EDITOR=vi`.")]
    NoEditor,
    #[error("The editor failed: {message}")]
    EditorFailed { message: String },
    #[error("TIKK_AGENT is not set. Set it to the agent's name, such as `TIKK_AGENT=manager`.")]
    NoAgent,
    #[error("{variable} is not valid Unicode.")]
    NotUnicode { variable: &'static str },
    #[error("{id} is claimed by {agent} until {lease_end}.")]
    Claimed {
        id: String,
        agent: String,
        lease_end: String,
    },
    #[error("Could not {action} {}: {source}", path.display())]
    Io {
        action: &'static str,
        path: PathBuf,
        source: io::Error,
    },
    #[error("`git {arguments}` did not finish within {} seconds, so tikk stopped it.", timeout.as_secs_f64())]
    GitTimeout {
        arguments: String,
        timeout: Duration,
    },
    #[error(
        "Sync stopped: {} changed both here and on the remote. tikk aborted the merge, so each file keeps the local text. To resolve it, run `git -C {} merge origin/main`, edit each listed file, then `git add` and `git commit` them.",
        describe_paths(files),
        store.display()
    )]
    Conflict { store: PathBuf, files: Vec<PathBuf> },
    #[error(
        "The merge stopped ({merge}), and the list of conflicting files could not be read: {read}. tikk aborted the merge."
    )]
    ConflictsUnreadable {
        merge: Box<StoreError>,
        read: Box<StoreError>,
    },
    #[error("{cause} Then the merge abort failed: {abort}. Run `git -C {} merge --abort`.", store.display())]
    MergeAbortFailed {
        store: PathBuf,
        cause: Box<StoreError>,
        abort: Box<StoreError>,
    },
    #[error(
        "Git refused to merge the remote, so nothing was merged: {message}. Fix or wait for the files it names, then run `tikk sync` again."
    )]
    MergeBlocked { message: String },
    #[error("{cause} Then unstaging the files sync staged failed: {unstage}. Run `git -C {} reset -q` before the next `tikk sync`.", store.display())]
    UnstageFailed {
        store: PathBuf,
        cause: Box<StoreError>,
        unstage: Box<StoreError>,
    },
    #[error("A merge is in progress in {}. Finish it with `git commit`, or stop it with `git merge --abort`, then run `tikk sync` again.", store.display())]
    MergeInProgress { store: PathBuf },
    #[error("The Git index of {} has staged changes that sync did not make: {}. Commit them, or unstage them with `git -C {} reset -q`, then run `tikk sync` again.", store.display(), describe_paths(paths), store.display())]
    StagedChanges { store: PathBuf, paths: Vec<PathBuf> },
    #[error("The store {} is on `{branch}`, not `main`. Run `git -C {} switch main`, then run `tikk sync` again.", store.display(), store.display())]
    NotOnMain { store: PathBuf, branch: String },
    #[error("{} lost or changed lines that are already committed. Facts are append-only: restore the committed lines, then run `tikk sync` again.", path.display())]
    FactRewritten { path: PathBuf },
    #[error("The remote `{url}` has branches but no `main`, so it is not a tikk store.")]
    RemoteWithoutMain { url: String },
    #[error(
        "The `main` branch of the remote `{url}` holds no tikk.json of version 1, so it is not a tikk store."
    )]
    RemoteNotAStore { url: String },
    #[error(
        "The remote already has facts/{machine}/, which another machine writes. Pass --machine with a new name, or `--machine {machine}` if this is that machine."
    )]
    MachineInUse { machine: String },
    #[error("gh could not read {}.", describe_pr_failures(failures))]
    Gh { failures: Vec<PrFailure> },
    #[error("{} is not a verdict file: {message}.", path.display())]
    InvalidVerdicts { path: PathBuf, message: String },
    #[error("{id} has no criterion `{criterion}`. Run `tikk show {id}` for its criteria.")]
    UnknownCriterion { id: String, criterion: String },
    #[error("{}", describe_no_repository(origin.as_deref()))]
    NoRepository { origin: Option<String> },
    #[error("{id} has no question `{item}`. Run `tikk show {id}` for its questions.")]
    UnknownQuestion { id: String, item: String },
    #[error("Found no free question item for {id}.")]
    NoFreeItem { id: String },
    #[error("{id} has no linked PR. Run `tikk pr link {id} <url>` first.")]
    NotLinked { id: String },
    #[error("{error} Then the sync result could not be saved: {save}")]
    ResultNotSaved {
        error: Box<StoreError>,
        save: Box<StoreError>,
    },
}

fn describe_cycle(steps: &[WaitStep]) -> String {
    steps
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

fn describe_no_repository(origin: Option<&str>) -> String {
    match origin {
        None => "The working directory has no Git `origin`, so the audit has no repository. Pass --repository <owner/name>.".to_owned(),
        Some(url) => format!("The origin URL `{url}` names no GitHub repository. Pass --repository <owner/name>."),
    }
}

fn describe_pr_failures(failures: &[PrFailure]) -> String {
    failures
        .iter()
        .map(|failure| {
            format!(
                "{} of {} ({})",
                failure.pull_request.url(),
                failure.slice,
                failure.message
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn describe_paths(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

#[derive(Clone, Copy)]
pub struct StoreEffects {
    pub run_git: fn(&Path, &[&str]) -> Result<Vec<u8>, StoreError>,
    pub read_host_name: fn() -> Result<String, StoreError>,
}

impl StoreEffects {
    pub fn system() -> Self {
        Self {
            run_git: git::run_git,
            read_host_name: system::read_host_name,
        }
    }
}

#[derive(Debug)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn root(&self) -> &Path {
        &self.root
    }
}

pub fn store_path(
    tikk_home: Option<OsString>,
    home: Option<OsString>,
) -> Result<PathBuf, StoreError> {
    if let Some(tikk_home) = tikk_home.filter(|value| !value.is_empty()) {
        return absolute(PathBuf::from(tikk_home));
    }

    let home = home
        .filter(|value| !value.is_empty())
        .ok_or(StoreError::NoStorePath)?;

    absolute(PathBuf::from(home).join(STORE_UNDER_HOME))
}

/// Git ignores a relative `GIT_CEILING_DIRECTORIES`, so every store path is absolute.
fn absolute(path: PathBuf) -> Result<PathBuf, StoreError> {
    std::path::absolute(&path).map_err(|source| StoreError::Io {
        action: "resolve",
        path,
        source,
    })
}

pub fn open(root: &Path) -> Result<Store, StoreError> {
    if !has_config(root)? {
        return Err(StoreError::NotInitialized {
            store: root.to_path_buf(),
        });
    }

    Ok(Store {
        root: root.to_path_buf(),
    })
}

/// Returns whether the folder holds `tikk.json`, and refuses one that is not version 1.
fn has_config(root: &Path) -> Result<bool, StoreError> {
    let path = root.join(CONFIG_FILE);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(source) => {
            return Err(StoreError::Io {
                action: "read",
                path,
                source,
            });
        }
    };
    let config: Option<serde_json::Value> = serde_json::from_str(&text).ok();

    if config != Some(serde_json::json!({ "version": 1 })) {
        return Err(StoreError::InvalidConfig { path });
    }

    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::fs;
    use std::path::PathBuf;

    use super::{PrFailure, StoreError, open, store_path};
    use crate::fact::PullRequest;
    use crate::ticket::TicketId;

    #[test]
    fn a_gh_error_names_each_failed_pr_its_slice_and_the_reason() {
        let failure = |number: u64, slice: &str, message: &str| PrFailure {
            slice: TicketId::parse(slice).expect("a valid ID"),
            pull_request: PullRequest::new("owner/app", number).expect("a valid PR"),
            message: message.to_owned(),
        };
        let error = StoreError::Gh {
            failures: vec![
                failure(7, "tikk-abcd", "HTTP 502"),
                failure(8, "tikk-efgh", "timed out"),
            ],
        };

        assert_eq!(
            error.to_string(),
            "gh could not read https://github.com/owner/app/pull/7 of tikk-abcd (HTTP 502); https://github.com/owner/app/pull/8 of tikk-efgh (timed out)."
        );
    }

    #[test]
    fn no_repository_names_the_origin_it_read_and_the_flag_to_pass() {
        let missing = StoreError::NoRepository { origin: None }.to_string();
        let other = StoreError::NoRepository {
            origin: Some("https://gitlab.com/owner/app.git".to_owned()),
        }
        .to_string();

        assert!(missing.contains("no Git `origin`"), "{missing}");
        assert!(
            other.contains("`https://gitlab.com/owner/app.git` names no GitHub repository"),
            "{other}"
        );
        for message in [missing, other] {
            assert!(message.contains("--repository <owner/name>"), "{message}");
        }
    }

    #[test]
    fn a_conflict_names_each_file() {
        let error = StoreError::Conflict {
            store: PathBuf::from("/store"),
            files: vec![PathBuf::from("tickets/a.md"), PathBuf::from("tickets/b.md")],
        };

        assert!(
            error
                .to_string()
                .starts_with("Sync stopped: tickets/a.md, tickets/b.md changed both here"),
            "{error}"
        );
    }

    #[test]
    fn open_reports_not_initialized_for_a_missing_store() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let root = directory.path().join("store");

        let error = open(&root).expect_err("no store exists");

        assert!(
            matches!(&error, StoreError::NotInitialized { store } if *store == root),
            "{error:?}"
        );
    }

    #[test]
    fn open_finds_a_folder_with_tikk_json() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        fs::write(directory.path().join("tikk.json"), "{\"version\":1}\n")
            .expect("write tikk.json");

        let store = open(directory.path()).expect("the store opens");

        assert_eq!(store.root(), directory.path());
    }

    #[test]
    fn store_path_makes_a_relative_tikk_home_absolute() {
        let path = store_path(Some(OsString::from("candidate")), None).expect("a path is found");

        assert_eq!(
            path,
            std::env::current_dir()
                .expect("read the current folder")
                .join("candidate")
        );
    }

    #[test]
    fn store_path_prefers_tikk_home_then_home() {
        let cases = [
            (Some("/data/tikk"), Some("/home/user"), "/data/tikk"),
            (None, Some("/home/user"), "/home/user/.local/share/tikk"),
            (Some(""), Some("/home/user"), "/home/user/.local/share/tikk"),
        ];

        for (tikk_home, home, expected) in cases {
            let path = store_path(tikk_home.map(OsString::from), home.map(OsString::from))
                .expect("a path is found");

            assert_eq!(
                path,
                PathBuf::from(expected),
                "case {tikk_home:?}, {home:?}"
            );
        }
    }

    #[test]
    fn store_path_needs_tikk_home_or_home() {
        for home in [None, Some(OsString::new())] {
            let error = store_path(None, home.clone()).expect_err("no path can be found");

            assert!(
                matches!(error, StoreError::NoStorePath),
                "case {home:?}: {error:?}"
            );
        }
    }
}
