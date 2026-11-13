use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt as _;
use std::path::{Path, PathBuf};

use crate::store::StoreError;
use crate::store::sync::{SyncEffects, SyncProblem, SyncStep};
use crate::store::sync_read::{MERGE_HEAD, ensure_no_merge};

const MERGE_MESSAGE: &str = "Merge the remote tikk store";

pub(crate) fn merge_fetched(
    root: &Path,
    commit: &str,
    effects: &SyncEffects,
) -> Result<(), StoreError> {
    let arguments = [
        "merge",
        "--quiet",
        "--no-edit",
        "--no-verify",
        "--message",
        MERGE_MESSAGE,
        commit,
    ];

    match (effects.run_git)(root, &arguments) {
        Ok(_) => Ok(()),
        Err(merge) => Err(merge_failure(root, merge, effects)),
    }
}

/// Merges like `merge_fetched`, but a merge that fails and leaves no merge in progress adds a
/// problem and returns `false`. A merge that cannot be aborted, or stays in progress, is an error.
pub(crate) fn merge_or_note(
    root: &Path,
    commit: &str,
    effects: &SyncEffects,
    problems: &mut Vec<SyncProblem>,
) -> Result<bool, StoreError> {
    let error = match merge_fetched(root, commit, effects) {
        Ok(()) => return Ok(true),
        Err(error @ StoreError::MergeAbortFailed { .. }) => return Err(error),
        Err(error) => error,
    };

    ensure_no_merge(root, effects)?;

    let files = match &error {
        StoreError::Conflict { files, .. } => files
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        _ => Vec::new(),
    };

    problems.push(SyncProblem {
        files,
        ..SyncProblem::new(SyncStep::Merge, error.to_string())
    });

    Ok(false)
}

fn merge_failure(root: &Path, merge: StoreError, effects: &SyncEffects) -> StoreError {
    let cause = match (effects.read_entry)(&root.join(MERGE_HEAD)) {
        Ok(None) => {
            return StoreError::MergeBlocked {
                message: git_message(merge),
            };
        }
        Ok(Some(_)) => conflict_cause(root, merge, effects),
        Err(read) => StoreError::ConflictsUnreadable {
            merge: Box::new(merge),
            read: Box::new(read),
        },
    };

    match (effects.run_git)(root, &["merge", "--abort"]) {
        Ok(_) => cause,
        Err(abort) => StoreError::MergeAbortFailed {
            store: root.to_path_buf(),
            cause: Box::new(cause),
            abort: Box::new(abort),
        },
    }
}

fn conflict_cause(root: &Path, merge: StoreError, effects: &SyncEffects) -> StoreError {
    let unmerged = (effects.run_git)(root, &["diff", "--name-only", "--diff-filter=U", "-z"]);

    match unmerged {
        Ok(output) => {
            let files: Vec<PathBuf> = output
                .split(|byte| *byte == 0)
                .filter(|name| !name.is_empty())
                .map(|name| PathBuf::from(OsStr::from_bytes(name)))
                .collect();

            if files.is_empty() {
                return merge;
            }

            StoreError::Conflict {
                store: root.to_path_buf(),
                files,
            }
        }
        Err(read) => StoreError::ConflictsUnreadable {
            merge: Box::new(merge),
            read: Box::new(read),
        },
    }
}

fn git_message(error: StoreError) -> String {
    match error {
        StoreError::Git { message, .. } => message,
        other => other.to_string(),
    }
}
