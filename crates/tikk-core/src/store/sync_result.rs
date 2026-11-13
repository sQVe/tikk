use std::fs;
use std::io;
use std::path::Path;

use serde::Deserialize;

use crate::fact::AttentionProblem;
use crate::store::sync::{RESULT_FILE, SyncStep};

#[derive(Deserialize)]
struct SavedResult {
    at: Option<String>,
    error: Option<String>,
    #[serde(default)]
    conflict: Vec<String>,
    problems: Option<Vec<SavedProblem>>,
}

#[derive(Deserialize)]
struct SavedProblem {
    step: String,
    message: String,
    #[serde(default)]
    files: Vec<String>,
}

// The caller holds the store lock. No saved result means no sync ran, which is not a problem. A
// store with no `origin` remote is local only, so the fetch it could not run is not a problem.
pub(crate) fn read_sync_problems(root: &Path, has_origin: bool) -> Vec<AttentionProblem> {
    let path = root.join(RESULT_FILE);
    let unreadable = |message: String| {
        vec![AttentionProblem::SyncResultUnreadable {
            path: path.clone(),
            message,
        }]
    };
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => return unreadable(error.to_string()),
    };
    let saved: SavedResult = match serde_json::from_str(&text) {
        Ok(saved) => saved,
        Err(error) => return unreadable(format!("the saved sync result is not valid: {error}")),
    };

    if let Some(message) = saved.error {
        return vec![AttentionProblem::SyncFailed {
            at: saved.at,
            message,
            files: saved.conflict,
        }];
    }

    let Some(problems) = saved.problems else {
        return unreadable("the saved sync result has neither `error` nor `problems`".to_owned());
    };

    problems
        .into_iter()
        .filter(|problem| has_origin || problem.step != SyncStep::Fetch.as_str())
        .map(|problem| AttentionProblem::SyncProblem {
            at: saved.at.clone(),
            step: problem.step,
            message: problem.message,
            files: problem.files,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::read_sync_problems;
    use crate::fact::AttentionProblem;

    fn read(saved: Option<&str>) -> Vec<AttentionProblem> {
        read_with_origin(saved, true)
    }

    fn read_with_origin(saved: Option<&str>, has_origin: bool) -> Vec<AttentionProblem> {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        fs::create_dir(directory.path().join(".git")).expect("create the Git folder");

        if let Some(saved) = saved {
            fs::write(directory.path().join(".git/tikk-sync.json"), saved)
                .expect("write the saved result");
        }

        read_sync_problems(directory.path(), has_origin)
    }

    #[test]
    fn no_saved_result_and_a_clean_outcome_have_no_problem() {
        let clean = "{\"at\":\"2026-11-13T01:00:00.000Z\",\"committed\":true,\"committedPaths\":[],\"pending\":[],\"fetched\":true,\"merged\":true,\"pushed\":true,\"problems\":[],\"clashes\":[]}";

        assert_eq!(read(None), []);
        assert_eq!(read(Some(clean)), []);
    }

    #[test]
    fn a_stopped_sync_names_its_error_and_conflicting_files() {
        let saved = "{\"at\":\"2026-11-13T01:00:00.000Z\",\"error\":\"Sync stopped.\",\"conflict\":[\"tickets/personal/personal-abcd-a.md\"]}";

        assert_eq!(
            read(Some(saved)),
            [AttentionProblem::SyncFailed {
                at: Some("2026-11-13T01:00:00.000Z".to_owned()),
                message: "Sync stopped.".to_owned(),
                files: vec!["tickets/personal/personal-abcd-a.md".to_owned()],
            }]
        );
    }

    #[test]
    fn each_problem_of_a_saved_outcome_is_listed_with_its_step_and_files() {
        let saved = "{\"at\":\"2026-11-13T01:00:00.000Z\",\"problems\":[{\"step\":\"push\",\"message\":\"rejected\"},{\"step\":\"merge\",\"message\":\"conflict\",\"files\":[\"tickets/a.md\"]}]}";

        assert_eq!(
            read(Some(saved)),
            [
                AttentionProblem::SyncProblem {
                    at: Some("2026-11-13T01:00:00.000Z".to_owned()),
                    step: "push".to_owned(),
                    message: "rejected".to_owned(),
                    files: Vec::new(),
                },
                AttentionProblem::SyncProblem {
                    at: Some("2026-11-13T01:00:00.000Z".to_owned()),
                    step: "merge".to_owned(),
                    message: "conflict".to_owned(),
                    files: vec!["tickets/a.md".to_owned()],
                },
            ]
        );
    }

    #[test]
    fn a_saved_result_that_does_not_parse_is_a_problem() {
        for saved in ["not json", "{\"at\":\"2026-11-13T01:00:00.000Z\"}"] {
            let problems = read(Some(saved));

            assert!(
                matches!(
                    problems.as_slice(),
                    [AttentionProblem::SyncResultUnreadable { path, .. }] if path.ends_with(".git/tikk-sync.json")
                ),
                "case {saved}: {problems:?}"
            );
        }
    }

    #[test]
    fn a_store_with_no_origin_drops_only_the_fetch_problem() {
        let outcome = "{\"at\":\"2026-11-13T01:00:00.000Z\",\"problems\":[{\"step\":\"fetch\",\"message\":\"no origin\"},{\"step\":\"commit\",\"message\":\"failed\"}]}";
        let stopped = "{\"at\":\"2026-11-13T01:00:00.000Z\",\"error\":\"Sync stopped.\"}";

        let kept = read_with_origin(Some(outcome), false);
        let failed = read_with_origin(Some(stopped), false);

        assert!(
            matches!(kept.as_slice(), [AttentionProblem::SyncProblem { step, .. }] if step == "commit"),
            "{kept:?}"
        );
        assert!(
            matches!(failed.as_slice(), [AttentionProblem::SyncFailed { .. }]),
            "{failed:?}"
        );
    }

    #[test]
    fn a_saved_result_that_cannot_be_read_is_a_problem() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        fs::create_dir_all(directory.path().join(".git/tikk-sync.json"))
            .expect("put a folder where the result file goes");

        let problems = read_sync_problems(directory.path(), true);

        assert!(
            matches!(
                problems.as_slice(),
                [AttentionProblem::SyncResultUnreadable { path, .. }] if path.ends_with(".git/tikk-sync.json")
            ),
            "{problems:?}"
        );
    }
}
