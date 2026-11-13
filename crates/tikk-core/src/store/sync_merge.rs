use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt as _;
use std::path::{Path, PathBuf};

use crate::store::StoreError;
use crate::store::sync::SyncEffects;
use crate::store::sync_read::MERGE_HEAD;

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
