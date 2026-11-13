use serde_json::Value;
use tikk_core::{Store, StoreError, SyncEffects, SyncOutcome};

use crate::output::Output;

pub(crate) fn run(store: &Store, effects: &SyncEffects) -> Result<Output, StoreError> {
    let outcome = tikk_core::sync_store(store, effects)?;

    Ok(Output {
        json: sync_json(&outcome),
        text: sync_text(&outcome),
    })
}

pub(crate) fn sync_json(outcome: &SyncOutcome) -> Value {
    serde_json::to_value(outcome).expect("a sync outcome holds only strings, booleans, and lists")
}

pub(crate) fn sync_text(outcome: &SyncOutcome) -> String {
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

    for clash in &outcome.clashes {
        let paths: Vec<String> = clash
            .paths
            .iter()
            .map(|path| path.display().to_string())
            .collect();

        lines.push(format!("idShared: {}  {}", clash.id, paths.join("  ")));
    }

    lines.join("\n")
}

fn yes_or_no(value: bool) -> &'static str {
    if value { "yes" } else { "no" }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use tikk_core::{
        IdClash, PendingFile, PendingReason, SyncOutcome, SyncProblem, SyncStep, TicketId,
    };

    use super::sync_text;

    #[test]
    fn sync_text_names_the_counts_each_pending_file_problem_and_clash() {
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
            problems: vec![SyncProblem::new(SyncStep::Fetch, "offline".to_owned())],
            clashes: vec![IdClash {
                id: TicketId::parse("personal-abcd").expect("a valid ID"),
                paths: vec![
                    PathBuf::from("tickets/personal/personal-abcd-a.md"),
                    PathBuf::from("tickets/personal/personal-abcd-c.md"),
                ],
            }],
        };

        assert_eq!(
            sync_text(&outcome),
            "committed: 1  fetched: no  merged: no  pushed: no\npending: tickets/personal/personal-wxyz-b.md  unparsed\nproblem: fetch: offline\nidShared: personal-abcd  tickets/personal/personal-abcd-a.md  tickets/personal/personal-abcd-c.md"
        );
    }
}
