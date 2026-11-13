use std::process::Command;
use std::time::Duration;

use serde::Deserialize;
use serde::de::DeserializeOwned;

use crate::fact::{PrObservation, PrState, PullRequest};
use crate::store::process_run::{NETWORK_TIMEOUT, RunFailure, run_within};
use crate::ticket::TicketId;

const VIEW_FIELDS: &str = "number,state,baseRefName,headRefOid,mergeCommit";

pub(crate) type RunGh = fn(&[&str]) -> Result<Vec<u8>, String>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrFailure {
    pub slice: TicketId,
    pub pull_request: PullRequest,
    pub message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPullRequest {
    number: u64,
    state: RawState,
    base_ref_name: String,
    head_ref_oid: String,
    merge_commit: Option<RawCommit>,
}

#[derive(Deserialize)]
#[serde(rename_all = "UPPERCASE")]
enum RawState {
    Open,
    Closed,
    Merged,
}

#[derive(Deserialize)]
struct RawCommit {
    oid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRepository {
    default_branch_ref: RawBranch,
}

#[derive(Deserialize)]
struct RawBranch {
    name: String,
}

#[derive(Deserialize)]
struct RawComparison {
    status: RawCompareStatus,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum RawCompareStatus {
    Ahead,
    Behind,
    Identical,
    Diverged,
}

pub(crate) fn run_gh(arguments: &[&str]) -> Result<Vec<u8>, String> {
    run_program("gh", arguments, NETWORK_TIMEOUT)
}

pub(crate) fn read_pull_request(
    run_gh: RunGh,
    pull_request: &PullRequest,
) -> Result<PrObservation, String> {
    let number = pull_request.number().to_string();
    let raw: RawPullRequest = read_json(
        run_gh,
        &[
            "pr",
            "view",
            &number,
            "--repo",
            pull_request.repository(),
            "--json",
            VIEW_FIELDS,
        ],
    )?;
    let observation = observation(pull_request, raw)?;

    if observation.state != PrState::Merged {
        return Ok(observation);
    }

    let in_trunk = merged_into_trunk(run_gh, &observation)?;

    Ok(PrObservation {
        in_trunk,
        ..observation
    })
}

fn observation(pull_request: &PullRequest, raw: RawPullRequest) -> Result<PrObservation, String> {
    if raw.number != pull_request.number() {
        return Err(format!(
            "gh returned the PR {} for {pull_request}",
            raw.number
        ));
    }

    if raw.base_ref_name.is_empty() || raw.head_ref_oid.is_empty() {
        return Err(format!("gh returned no base or head for {pull_request}"));
    }

    let state = match raw.state {
        RawState::Open => PrState::Open,
        RawState::Closed => PrState::Closed,
        RawState::Merged => PrState::Merged,
    };

    Ok(PrObservation {
        pull_request: pull_request.clone(),
        state,
        base: raw.base_ref_name,
        head: raw.head_ref_oid,
        merge_commit: raw.merge_commit.map(|commit| commit.oid),
        in_trunk: false,
    })
}

fn merged_into_trunk(run_gh: RunGh, observation: &PrObservation) -> Result<bool, String> {
    let repository = observation.pull_request.repository();
    let raw: RawRepository = read_json(
        run_gh,
        &["repo", "view", repository, "--json", "defaultBranchRef"],
    )?;
    let trunk = raw.default_branch_ref.name;

    if observation.base == trunk {
        return Ok(true);
    }

    let Some(merge_commit) = &observation.merge_commit else {
        return Ok(false);
    };
    let path = format!(
        "repos/{repository}/compare/{}...{merge_commit}",
        encode_path_segment(&trunk)
    );
    let comparison: RawComparison = read_json(run_gh, &["api", &path])?;

    Ok(match comparison.status {
        RawCompareStatus::Behind | RawCompareStatus::Identical => true,
        RawCompareStatus::Ahead | RawCompareStatus::Diverged => false,
    })
}

fn read_json<T: DeserializeOwned>(run_gh: RunGh, arguments: &[&str]) -> Result<T, String> {
    let command = arguments.join(" ");
    let output =
        run_gh(arguments).map_err(|message| format!("`gh {command}` failed: {message}"))?;

    serde_json::from_slice(&output)
        .map_err(|error| format!("`gh {command}` printed output tikk cannot read: {error}"))
}

fn run_program(program: &str, arguments: &[&str], timeout: Duration) -> Result<Vec<u8>, String> {
    let mut command = Command::new(program);

    command.args(arguments).env("GH_PROMPT_DISABLED", "1");

    let finished = run_within(&mut command, timeout).map_err(|failure| match failure {
        RunFailure::TimedOut => format!(
            "it did not finish within {} seconds, so tikk stopped it",
            timeout.as_secs_f64()
        ),
        RunFailure::Failed(message) => message,
    })?;

    if !finished.status.success() {
        let message = String::from_utf8_lossy(&finished.stderr).trim().to_owned();

        return Err(if message.is_empty() {
            format!("it exited with {}", finished.status)
        } else {
            message
        });
    }

    Ok(finished.stdout)
}

fn encode_path_segment(text: &str) -> String {
    let mut encoded = String::new();

    for byte in text.bytes() {
        let unreserved = byte.is_ascii_alphanumeric() || b"-._~".contains(&byte);

        if unreserved {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }

    encoded
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::path::Path;
    use std::time::Duration;

    use super::{encode_path_segment, read_pull_request, run_program};
    use crate::fact::{PrObservation, PrState, PullRequest};

    thread_local! {
        static ANSWERS: RefCell<HashMap<String, Result<String, String>>> = RefCell::new(HashMap::new());
        static CALLS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    }

    const VIEW: &str =
        "pr view 7 --repo owner/app --json number,state,baseRefName,headRefOid,mergeCommit";
    const REPOSITORY: &str = "repo view owner/app --json defaultBranchRef";
    const TRUNK: &str = "{\"defaultBranchRef\":{\"name\":\"main\"}}";

    fn fake_gh(arguments: &[&str]) -> Result<Vec<u8>, String> {
        let call = arguments.join(" ");

        CALLS.with(|calls| calls.borrow_mut().push(call.clone()));

        ANSWERS.with(|answers| {
            answers
                .borrow()
                .get(&call)
                .cloned()
                .unwrap_or_else(|| Err(format!("no answer for {call}")))
                .map(String::into_bytes)
        })
    }

    fn answer(call: &str, text: &str) {
        ANSWERS.with(|answers| {
            answers
                .borrow_mut()
                .insert(call.to_owned(), Ok(text.to_owned()))
        });
    }

    fn view(state: &str, base: &str, merge_commit: Option<&str>) -> String {
        let merge_commit =
            merge_commit.map_or("null".to_owned(), |oid| format!("{{\"oid\":\"{oid}\"}}"));

        format!(
            "{{\"number\":7,\"state\":\"{state}\",\"baseRefName\":\"{base}\",\"headRefOid\":\"head\",\"mergeCommit\":{merge_commit}}}"
        )
    }

    fn pull_request() -> PullRequest {
        PullRequest::new("owner/app", 7).expect("a valid PR")
    }

    fn read() -> (Result<PrObservation, String>, Vec<String>) {
        let result = read_pull_request(fake_gh, &pull_request());
        let calls = CALLS.with(|calls| calls.take());

        ANSWERS.with(|answers| answers.borrow_mut().clear());

        (result, calls)
    }

    #[test]
    fn an_open_or_closed_pr_is_read_with_one_call_and_is_not_in_trunk() {
        for (state, expected) in [("OPEN", PrState::Open), ("CLOSED", PrState::Closed)] {
            answer(VIEW, &view(state, "main", None));

            let (result, calls) = read();

            assert_eq!(
                result,
                Ok(PrObservation {
                    pull_request: pull_request(),
                    state: expected,
                    base: "main".to_owned(),
                    head: "head".to_owned(),
                    merge_commit: None,
                    in_trunk: false,
                }),
                "case {state}"
            );
            assert_eq!(calls, [VIEW], "case {state}");
        }
    }

    #[test]
    fn a_pr_merged_into_trunk_is_in_trunk_without_a_compare() {
        answer(VIEW, &view("MERGED", "main", Some("merge")));
        answer(REPOSITORY, TRUNK);

        let (result, calls) = read();

        let observation = result.expect("the PR is read");
        assert_eq!(observation.state, PrState::Merged);
        assert_eq!(observation.merge_commit.as_deref(), Some("merge"));
        assert!(observation.in_trunk);
        assert_eq!(calls, [VIEW, REPOSITORY]);
    }

    #[test]
    fn a_pr_merged_into_another_branch_is_in_trunk_once_trunk_holds_its_merge_commit() {
        let compare = "api repos/owner/app/compare/main...merge";
        let cases = [
            ("ahead", false),
            ("diverged", false),
            ("behind", true),
            ("identical", true),
        ];

        for (status, expected) in cases {
            answer(VIEW, &view("MERGED", "feature", Some("merge")));
            answer(REPOSITORY, TRUNK);
            answer(compare, &format!("{{\"status\":\"{status}\"}}"));

            let (result, calls) = read();

            assert_eq!(
                result.map(|observation| observation.in_trunk),
                Ok(expected),
                "case {status}"
            );
            assert_eq!(calls, [VIEW, REPOSITORY, compare], "case {status}");
        }
    }

    #[test]
    fn a_pr_merged_into_another_branch_without_a_merge_commit_is_not_in_trunk() {
        answer(VIEW, &view("MERGED", "feature", None));
        answer(REPOSITORY, TRUNK);

        let (result, calls) = read();

        assert_eq!(result.map(|observation| observation.in_trunk), Ok(false));
        assert_eq!(calls, [VIEW, REPOSITORY]);
    }

    #[test]
    fn output_that_tikk_cannot_read_is_an_error_that_names_the_call() {
        let cases = [
            (
                vec![(VIEW, "not json".to_owned())],
                "pr view 7",
                "cannot read",
            ),
            (
                vec![(VIEW, view("DRAFT", "main", None))],
                "pr view 7",
                "cannot read",
            ),
            (
                vec![(
                    VIEW,
                    view("OPEN", "main", None).replace("\"number\":7", "\"number\":8"),
                )],
                "owner/app#7",
                "the PR 8",
            ),
            (
                vec![(VIEW, view("OPEN", "", None))],
                "owner/app#7",
                "no base or head",
            ),
            (
                vec![
                    (VIEW, view("MERGED", "feature", Some("merge"))),
                    (REPOSITORY, "{}".to_owned()),
                ],
                "repo view owner/app",
                "cannot read",
            ),
        ];

        for (index, (answers, names, expected)) in cases.into_iter().enumerate() {
            for (call, text) in answers {
                answer(call, &text);
            }

            let (result, _calls) = read();

            let error = result.expect_err("the read fails");
            assert!(
                error.contains(names) && error.contains(expected),
                "case {index}: {error}"
            );
        }
    }

    #[test]
    fn a_failed_call_names_the_command_and_its_error() {
        let (result, _calls) = read();

        assert_eq!(
            result,
            Err(format!("`gh {VIEW}` failed: no answer for {VIEW}"))
        );
    }

    fn fake_program(folder: &Path, body: &str) -> String {
        use std::os::unix::fs::PermissionsExt as _;

        let path = folder.join("fake-gh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write the fake gh");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("make the fake gh executable");

        path.to_str().expect("a UTF-8 path").to_owned()
    }

    #[test]
    fn run_program_returns_the_output_or_the_error_text() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let timeout = Duration::from_secs(10);
        let passing = fake_program(
            directory.path(),
            "echo \"$GH_PROMPT_DISABLED $*\"; echo noise >&2",
        );

        assert_eq!(
            run_program(&passing, &["pr", "view"], timeout),
            Ok(b"1 pr view\n".to_vec())
        );

        let failing = fake_program(directory.path(), "echo 'HTTP 404' >&2; exit 1");
        assert_eq!(
            run_program(&failing, &[], timeout),
            Err("HTTP 404".to_owned())
        );

        let silent = fake_program(directory.path(), "exit 3");
        let error = run_program(&silent, &[], timeout).expect_err("the program fails");
        assert!(error.contains("exited with"), "{error}");
    }

    #[test]
    fn run_program_names_a_missing_program_and_stops_a_slow_one() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let slow = fake_program(directory.path(), "sleep 10");
        let started = std::time::Instant::now();

        let missing = run_program("tikk-test-no-such-program", &[], Duration::from_secs(1));
        let stopped = run_program(&slow, &[], Duration::from_millis(100));

        assert!(
            missing
                .as_ref()
                .is_err_and(|error| error.starts_with("could not start tikk-test-no-such-program")),
            "{missing:?}"
        );
        assert!(
            stopped
                .as_ref()
                .is_err_and(|error| error.contains("did not finish within 0.1 seconds")),
            "{stopped:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn encode_path_segment_keeps_plain_names_and_escapes_the_rest() {
        assert_eq!(encode_path_segment("main"), "main");
        assert_eq!(encode_path_segment("release/1.0_x~y"), "release%2F1.0_x~y");
        assert_eq!(encode_path_segment("a#b c"), "a%23b%20c");
    }
}
