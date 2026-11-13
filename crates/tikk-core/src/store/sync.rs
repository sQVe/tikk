use std::io::Write as _;
use std::path::Path;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use serde_json::json;

use crate::fact::Timestamp;
use crate::store::git;
use crate::store::id_clash::{IdClash, id_clashes};
use crate::store::store_lock::{self, LockAccess, StoreLock};
use crate::store::sync_commit::commit_plan;
use crate::store::sync_merge::merge_fetched;
use crate::store::sync_read::{self, SyncPlan, read_plan, settle_deadline};
use crate::store::ticket_files::{TicketScan, io_error, read_tickets};
use crate::store::{Store, StoreError};

const RESULT_FILE: &str = ".git/tikk-sync.json";

#[derive(Clone, Copy)]
pub struct SyncEffects {
    pub run_git: fn(&Path, &[&str]) -> Result<Vec<u8>, StoreError>,
    pub run_network_git: fn(&Path, &[&str]) -> Result<Vec<u8>, StoreError>,
    pub read_origin: fn(&Path) -> Result<Option<String>, StoreError>,
    /// Reads a file of the store without following a symlink. A missing file is `None`.
    pub read_entry: fn(&Path) -> Result<Option<FileEntry>, StoreError>,
    pub lock_store: fn(&Path, LockAccess) -> Result<StoreLock, StoreError>,
    pub now: fn() -> SystemTime,
    pub wait: fn(Duration),
}

impl SyncEffects {
    pub fn system() -> Self {
        Self {
            run_git: git::run_store_git,
            run_network_git: git::run_network_git,
            read_origin: git::read_store_origin,
            read_entry: sync_read::read_entry,
            lock_store: store_lock::lock_store,
            now: SystemTime::now,
            wait: std::thread::sleep,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEntry {
    pub bytes: Vec<u8>,
    pub kind: FileKind,
    pub modified: SystemTime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    File,
    Executable,
    Symlink,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub committed: bool,
    pub committed_paths: Vec<String>,
    pub pending: Vec<PendingFile>,
    pub fetched: bool,
    pub merged: bool,
    pub pushed: bool,
    pub problems: Vec<SyncProblem>,
    pub clashes: Vec<IdClash>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PendingFile {
    pub path: String,
    pub reason: PendingReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingReason {
    Settling,
    Unparsed,
    NameNotUtf8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SyncProblem {
    pub step: SyncStep,
    pub message: String,
    /// The files of a merge conflict.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

impl SyncProblem {
    pub fn new(step: SyncStep, message: String) -> Self {
        Self {
            step,
            message,
            files: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncStep {
    Fetch,
    Merge,
    Commit,
    Push,
    Save,
}

impl PendingReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Settling => "settling",
            Self::Unparsed => "unparsed",
            Self::NameNotUtf8 => "nameNotUtf8",
        }
    }
}

impl Serialize for PendingReason {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl SyncStep {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fetch => "fetch",
            Self::Merge => "merge",
            Self::Commit => "commit",
            Self::Push => "push",
            Self::Save => "save",
        }
    }
}

impl Serialize for SyncStep {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

pub fn sync_store(store: &Store, effects: &SyncEffects) -> Result<SyncOutcome, StoreError> {
    let root = store.root();

    match run_sync(root, effects) {
        Ok(outcome) => Ok(save_outcome(root, effects, outcome)),
        Err(error) => Err(save_error(root, effects, error)),
    }
}

/// Saves the result as the last sync result. A failed save joins the problems.
pub(crate) fn save_outcome(
    root: &Path,
    effects: &SyncEffects,
    mut outcome: SyncOutcome,
) -> SyncOutcome {
    if let Err(save) = save_result(root, &saved_outcome(now(effects), &outcome)) {
        outcome
            .problems
            .push(SyncProblem::new(SyncStep::Save, save.to_string()));
    }

    outcome
}

/// Saves the error as the last sync result, and returns it.
pub(crate) fn save_error(root: &Path, effects: &SyncEffects, error: StoreError) -> StoreError {
    let saved = save_result(root, &saved_error(now(effects), &error));

    not_saved(error, saved)
}

/// Saves the steps that ran before a refusal, and returns the refusal.
pub(crate) fn save_refused(
    root: &Path,
    effects: &SyncEffects,
    outcome: SyncOutcome,
    refusal: StoreError,
) -> StoreError {
    let saved = save_result(root, &saved_outcome(now(effects), &outcome));

    not_saved(refusal, saved)
}

fn not_saved(error: StoreError, saved: Result<(), StoreError>) -> StoreError {
    match saved {
        Ok(()) => error,
        Err(save) => StoreError::ResultNotSaved {
            error: Box::new(error),
            save: Box::new(save),
        },
    }
}

fn now(effects: &SyncEffects) -> Timestamp {
    Timestamp::from_system_time((effects.now)())
}

fn run_sync(root: &Path, effects: &SyncEffects) -> Result<SyncOutcome, StoreError> {
    let origin = (effects.read_origin)(root)?;
    let deadline = settle_deadline(root, effects)?;
    let mut problems = Vec::new();
    let fetched = fetch_origin(root, origin.as_deref(), effects, &mut problems);

    wait_until(deadline, effects);

    let (plan, merged, clashes) = {
        let _lock = (effects.lock_store)(root, LockAccess::Exclusive)?;
        let plan = read_plan(root, fetched, effects)?;

        commit_plan(root, &plan, effects.run_git)?;

        let merged = match &plan.fetched {
            Some(commit) => {
                merge_fetched(root, commit, effects)?;

                true
            }
            None => false,
        };

        (plan, merged, read_clashes(root)?)
    };
    let pushed = fetched && push(root, effects, &mut problems);

    Ok(SyncOutcome {
        clashes,
        ..outcome(plan, fetched, merged, pushed, problems)
    })
}

/// Fetches from `origin` and returns whether the fetch ran. A store with no `origin` and a failed
/// fetch each add a problem.
pub(crate) fn fetch_origin(
    root: &Path,
    origin: Option<&str>,
    effects: &SyncEffects,
    problems: &mut Vec<SyncProblem>,
) -> bool {
    if origin.is_none() {
        problems.push(SyncProblem::new(
            SyncStep::Fetch,
            "The store has no `origin` remote, so sync only commits.".to_owned(),
        ));

        return false;
    }

    let arguments = ["fetch", "--quiet", "--no-tags", "--prune", "origin"];

    match (effects.run_network_git)(root, &arguments) {
        Ok(_) => true,
        Err(error) => {
            problems.push(SyncProblem::new(SyncStep::Fetch, error.to_string()));

            false
        }
    }
}

pub(crate) fn push(root: &Path, effects: &SyncEffects, problems: &mut Vec<SyncProblem>) -> bool {
    let arguments = [
        "push",
        "--quiet",
        "--no-verify",
        "origin",
        "refs/heads/main:refs/heads/main",
    ];

    match (effects.run_network_git)(root, &arguments) {
        Ok(_) => true,
        Err(error) => {
            problems.push(SyncProblem::new(SyncStep::Push, error.to_string()));

            false
        }
    }
}

/// The ID clashes of the store, with paths relative to it. The caller holds the store lock.
pub(crate) fn read_clashes(root: &Path) -> Result<Vec<IdClash>, StoreError> {
    let scan = read_tickets(root)?;

    Ok(relative_clashes(root, &scan))
}

pub(crate) fn relative_clashes(root: &Path, scan: &TicketScan) -> Vec<IdClash> {
    id_clashes(scan)
        .into_iter()
        .map(|clash| IdClash {
            paths: clash
                .paths
                .iter()
                .map(|path| path.strip_prefix(root).unwrap_or(path).to_path_buf())
                .collect(),
            ..clash
        })
        .collect()
}

fn wait_until(deadline: Option<SystemTime>, effects: &SyncEffects) {
    let Some(deadline) = deadline else {
        return;
    };

    if let Ok(remaining) = deadline.duration_since((effects.now)()) {
        (effects.wait)(remaining);
    }
}

pub(crate) fn outcome(
    plan: SyncPlan,
    fetched: bool,
    merged: bool,
    pushed: bool,
    problems: Vec<SyncProblem>,
) -> SyncOutcome {
    let committed_paths: Vec<String> = plan.committed_paths();

    SyncOutcome {
        committed: !committed_paths.is_empty(),
        committed_paths,
        pending: plan.pending,
        fetched,
        merged,
        pushed,
        problems,
        clashes: Vec::new(),
    }
}

fn saved_outcome(at: Timestamp, outcome: &SyncOutcome) -> serde_json::Value {
    let mut saved = serde_json::to_value(outcome)
        .expect("a sync outcome holds only strings, booleans, and lists");

    saved["at"] = json!(at.to_string());

    saved
}

fn save_result(root: &Path, saved: &serde_json::Value) -> Result<(), StoreError> {
    let path = root.join(RESULT_FILE);
    let folder = path.parent().expect("the result file is inside .git");
    let mut file = tempfile::NamedTempFile::new_in(folder)
        .map_err(|source| io_error("create a file in", folder, source))?;

    writeln!(file, "{saved}").map_err(|source| io_error("write", file.path(), source))?;
    file.persist(&path)
        .map_err(|error| io_error("replace", &path, error.error))?;

    Ok(())
}

fn saved_error(at: Timestamp, error: &StoreError) -> serde_json::Value {
    let mut saved = json!({ "at": at.to_string(), "error": error.to_string() });

    if let StoreError::Conflict { files, .. } = error {
        let files: Vec<String> = files
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();

        saved["conflict"] = json!(files);
    }

    saved
}

#[cfg(test)]
#[path = "sync_tests.rs"]
mod tests;
