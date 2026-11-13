use std::path::Path;

use crate::store::StoreError;
use crate::store::store_lock::LockAccess;
use crate::store::sync::{
    SyncEffects, SyncOutcome, SyncProblem, SyncStep, fetch_origin, outcome, push, relative_clashes,
    save_error, save_outcome, save_refused,
};
use crate::store::sync_commit::commit_plan;
use crate::store::sync_merge::merge_or_note;
use crate::store::sync_read::{SyncPlan, read_fetched_commit, read_plan};
use crate::store::ticket_files::{TicketScan, read_tickets};

/// The result of a write that syncs the store around it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Synced<T> {
    pub value: T,
    pub sync: SyncOutcome,
}

/// What the change under the lock returns: its value and whether it appended a fact.
pub(crate) struct Change<T> {
    pub(crate) value: T,
    pub(crate) appended: bool,
}

struct Steps<T> {
    outcome: SyncOutcome,
    change: Result<T, StoreError>,
}

/// Fetches outside the lock. Then, in one hold of the exclusive lock, merges the fetched commit,
/// runs the change on the merged tickets, and commits what it appended with the settled files.
/// Then pushes outside the lock. A failed fetch, merge, commit, or push is a problem in the sync
/// result, not an error, unless it leaves a merge in progress. The result is saved either way.
pub(crate) fn sync_around<T>(
    root: &Path,
    effects: &SyncEffects,
    change: impl FnOnce(&TicketScan) -> Result<Change<T>, StoreError>,
) -> Result<Synced<T>, StoreError> {
    match run_steps(root, effects, change) {
        Ok(Steps {
            outcome,
            change: Ok(value),
        }) => Ok(Synced {
            value,
            sync: save_outcome(root, effects, outcome),
        }),
        Ok(Steps {
            outcome,
            change: Err(refusal),
        }) => Err(save_refused(root, effects, outcome, refusal)),
        Err(error) => Err(save_error(root, effects, error)),
    }
}

fn run_steps<T>(
    root: &Path,
    effects: &SyncEffects,
    change: impl FnOnce(&TicketScan) -> Result<Change<T>, StoreError>,
) -> Result<Steps<T>, StoreError> {
    let mut problems = Vec::new();
    let origin = (effects.read_origin)(root)?;
    let fetched = fetch_origin(root, origin.as_deref(), effects, &mut problems);
    let lock = (effects.lock_store)(root, LockAccess::Exclusive)?;
    let fetched_commit = read_fetched_commit(root, fetched, effects)?;
    let merged = match &fetched_commit {
        Some(commit) => merge_or_note(root, commit, effects, &mut problems)?,
        None => false,
    };
    let merge_failed = fetched_commit.is_some() && !merged;
    let scan = read_tickets(root)?;
    let clashes = relative_clashes(root, &scan);
    let changed = match change(&scan) {
        Ok(changed) => changed,
        Err(refusal) => {
            return Ok(Steps {
                outcome: SyncOutcome {
                    clashes,
                    ..outcome(SyncPlan::default(), fetched, merged, false, problems)
                },
                change: Err(refusal),
            });
        }
    };
    let committed = changed
        .appended
        .then(|| commit_change(root, effects, &mut problems))
        .flatten();

    drop(lock);

    let may_push = fetched && !merge_failed && committed.is_some();
    let pushed = may_push && push(root, effects, &mut problems);

    Ok(Steps {
        outcome: SyncOutcome {
            clashes,
            ..outcome(
                committed.unwrap_or_default(),
                fetched,
                merged,
                pushed,
                problems,
            )
        },
        change: Ok(changed.value),
    })
}

/// Commits the appended fact and the settled files. A failure is a problem, and the plan is `None`.
fn commit_change(
    root: &Path,
    effects: &SyncEffects,
    problems: &mut Vec<SyncProblem>,
) -> Option<SyncPlan> {
    let committed = read_plan(root, false, effects)
        .and_then(|plan| commit_plan(root, &plan, effects.run_git).map(|()| plan));

    match committed {
        Ok(plan) => Some(plan),
        Err(error) => {
            problems.push(SyncProblem::new(SyncStep::Commit, error.to_string()));

            None
        }
    }
}

#[cfg(test)]
#[path = "claim_sync_tests.rs"]
mod tests;
