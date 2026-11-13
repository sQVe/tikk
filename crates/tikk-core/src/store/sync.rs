use std::io::Write as _;
use std::path::Path;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use serde_json::json;

use crate::fact::Timestamp;
use crate::store::store_lock::{self, LockAccess, StoreLock};
use crate::store::sync_commit::commit_plan;
use crate::store::sync_merge::merge_fetched;
use crate::store::sync_read::{self, SyncPlan, read_plan, settle_deadline};
use crate::store::system;
use crate::store::ticket_files::io_error;
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
            run_git: system::run_store_git,
            run_network_git: system::run_network_git,
            read_origin: system::read_store_origin,
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncStep {
    Fetch,
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
    let outcome = run_sync(root, effects);
    let at = Timestamp::from_system_time((effects.now)());
    let saved = save_result(root, at, &outcome);

    match (outcome, saved) {
        (Ok(mut outcome), Err(save)) => {
            outcome.problems.push(SyncProblem {
                step: SyncStep::Save,
                message: save.to_string(),
            });

            Ok(outcome)
        }
        (Ok(outcome), Ok(())) => Ok(outcome),
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(save)) => Err(StoreError::ResultNotSaved {
            error: Box::new(error),
            save: Box::new(save),
        }),
    }
}

fn run_sync(root: &Path, effects: &SyncEffects) -> Result<SyncOutcome, StoreError> {
    let origin = (effects.read_origin)(root)?;
    let deadline = settle_deadline(root, effects)?;
    let mut problems = Vec::new();
    let fetched = match origin {
        None => {
            problems.push(SyncProblem {
                step: SyncStep::Fetch,
                message: "The store has no `origin` remote, so sync only commits.".to_owned(),
            });

            false
        }
        Some(_) => fetch(root, effects, &mut problems),
    };

    wait_until(deadline, effects);

    let (plan, merged) = {
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

        (plan, merged)
    };
    let pushed = fetched && push(root, effects, &mut problems);

    Ok(outcome(plan, fetched, merged, pushed, problems))
}

fn fetch(root: &Path, effects: &SyncEffects, problems: &mut Vec<SyncProblem>) -> bool {
    let arguments = ["fetch", "--quiet", "--no-tags", "--prune", "origin"];

    match (effects.run_network_git)(root, &arguments) {
        Ok(_) => true,
        Err(error) => {
            problems.push(SyncProblem {
                step: SyncStep::Fetch,
                message: error.to_string(),
            });

            false
        }
    }
}

fn push(root: &Path, effects: &SyncEffects, problems: &mut Vec<SyncProblem>) -> bool {
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
            problems.push(SyncProblem {
                step: SyncStep::Push,
                message: error.to_string(),
            });

            false
        }
    }
}

fn wait_until(deadline: Option<SystemTime>, effects: &SyncEffects) {
    let Some(deadline) = deadline else {
        return;
    };

    if let Ok(remaining) = deadline.duration_since((effects.now)()) {
        (effects.wait)(remaining);
    }
}

fn outcome(
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
    }
}

fn save_result(
    root: &Path,
    at: Timestamp,
    outcome: &Result<SyncOutcome, StoreError>,
) -> Result<(), StoreError> {
    let saved = match outcome {
        Ok(outcome) => {
            let mut saved = serde_json::to_value(outcome)
                .expect("a sync outcome holds only strings, booleans, and lists");

            saved["at"] = json!(at.to_string());

            saved
        }
        Err(error) => saved_error(at, error),
    };
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
