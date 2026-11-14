use tikk_core::{Store, StoreError, SyncEffects, SyncOutcome};

use crate::output::Output;

pub(crate) fn run(store: &Store, effects: &SyncEffects) -> Result<Output, StoreError> {
    let outcome = tikk_core::sync_store(store, effects)?;

    Ok(Output {
        json: serde_json::to_value(&outcome)
            .expect("a sync outcome holds only strings, booleans, and lists"),
        text: sync_text(&outcome),
    })
}

fn sync_text(outcome: &SyncOutcome) -> String {
    let mut lines = vec![format!(
        "committed: {}  fetched: {}  merged: {}  pushed: {}",
        outcome.committed_paths.len(),
        yes_or_no(outcome.fetched),
        yes_or_no(outcome.merged),
        yes_or_no(outcome.pushed)
    )];

    for file in &outcome.pending {
        lines.push(format!("pending: {}  {}", file.path, file.reason.as_str()));
    }

    for problem in &outcome.problems {
        lines.push(format!(
            "problem: {}: {}",
            problem.step.as_str(),
            problem.message
        ));
    }

    lines.join("\n")
}

fn yes_or_no(value: bool) -> &'static str {
    if value { "yes" } else { "no" }
}

#[cfg(test)]
mod tests {
    use tikk_core::{PendingFile, PendingReason, SyncOutcome, SyncProblem, SyncStep};

    use super::sync_text;

    #[test]
    fn sync_text_names_the_counts_each_pending_file_and_each_problem() {
        let outcome = SyncOutcome {
            committed: true,
            committed_paths: vec!["tickets/personal/personal-abcd-a.md".to_owned()],
            pending: vec![PendingFile {
                path: "tickets/personal/personal-wxyz-b.md".to_owned(),
                reason: PendingReason::Unparsed,
            }],
            fetched: false,
            merged: false,
            pushed: false,
            problems: vec![SyncProblem {
                step: SyncStep::Fetch,
                message: "offline".to_owned(),
            }],
        };

        assert_eq!(
            sync_text(&outcome),
            "committed: 1  fetched: no  merged: no  pushed: no\npending: tickets/personal/personal-wxyz-b.md  unparsed\nproblem: fetch: offline"
        );
    }
}
