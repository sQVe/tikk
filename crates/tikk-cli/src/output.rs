use std::process::ExitCode;

use serde::Serialize;
use serde_json::{Value, json};
use tikk_core::TicketId;

pub(crate) struct Output {
    pub(crate) json: Value,
    pub(crate) text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Exit {
    Success,
    Refused,
    WrongUsage,
}

impl Exit {
    fn code(self) -> u8 {
        match self {
            Self::Success => 0,
            Self::Refused => 1,
            Self::WrongUsage => 2,
        }
    }
}

// The keys print in field order where serde_json keeps insertion order, which a workspace build
// turns on through GPUI, and sorted otherwise. Reordering the fields changes the output there.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Failure {
    pub(crate) code: &'static str,
    pub(crate) message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) files: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) pull_requests: Option<Vec<PullRequestFailure>>,
    #[serde(skip)]
    pub(crate) exit: Exit,
}

// Field order matters as for `Failure`.
#[derive(Serialize)]
pub(crate) struct PullRequestFailure {
    pub(crate) id: TicketId,
    pub(crate) repository: String,
    pub(crate) number: u64,
    pub(crate) url: String,
    pub(crate) message: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Response {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) exit: Exit,
}

impl Response {
    pub(crate) fn success(json: bool, output: &Output) -> Self {
        let stdout = if json {
            format!("{}\n", output.json)
        } else {
            format!("{}\n", output.text)
        };

        Self {
            stdout,
            stderr: String::new(),
            exit: Exit::Success,
        }
    }

    pub(crate) fn failure(json: bool, failure: &Failure) -> Self {
        let stderr = if json {
            format!("{}\n", json!({ "error": failure }))
        } else {
            format!("error: {}\n", failure.message)
        };

        Self {
            stdout: String::new(),
            stderr,
            exit: failure.exit,
        }
    }
}

pub(crate) fn write(response: &Response) -> ExitCode {
    write_stdout(&response.stdout);
    write_stderr(&response.stderr);

    ExitCode::from(response.exit.code())
}

#[expect(
    clippy::print_stdout,
    reason = "this is the one writer of command output"
)]
fn write_stdout(text: &str) {
    print!("{text}");
}

#[expect(clippy::print_stderr, reason = "this is the one writer of errors")]
fn write_stderr(text: &str) {
    eprint!("{text}");
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tikk_core::{PrFailure, PullRequest, StoreError, TicketId};

    use super::{Exit, Failure, Output, Response};
    use crate::store_error;

    #[test]
    fn exit_codes_follow_the_contract() {
        let cases = [
            (Exit::Success, 0),
            (Exit::Refused, 1),
            (Exit::WrongUsage, 2),
        ];

        for (exit, code) in cases {
            assert_eq!(exit.code(), code, "case {exit:?}");
        }
    }

    #[test]
    fn success_prints_the_bare_json_result_on_standard_output() {
        let output = Output {
            json: json!({ "created": true }),
            text: "Created.".to_owned(),
        };

        let response = Response::success(true, &output);

        assert_eq!(
            response,
            Response {
                stdout: "{\"created\":true}\n".to_owned(),
                stderr: String::new(),
                exit: Exit::Success,
            }
        );
    }

    #[test]
    fn success_without_json_prints_the_text() {
        let output = Output {
            json: json!({ "created": true }),
            text: "Created.".to_owned(),
        };

        let response = Response::success(false, &output);

        assert_eq!(response.stdout, "Created.\n");
    }

    #[test]
    fn failure_prints_an_error_object_on_standard_error_only() {
        let failure = Failure {
            code: "notInitialized",
            message: "No store.".to_owned(),
            field: None,
            files: None,
            pull_requests: None,
            exit: Exit::Refused,
        };

        let response = Response::failure(true, &failure);

        assert_eq!(
            response,
            Response {
                stdout: String::new(),
                stderr: "{\"error\":{\"code\":\"notInitialized\",\"message\":\"No store.\"}}\n"
                    .to_owned(),
                exit: Exit::Refused,
            }
        );
    }

    #[test]
    fn failure_with_every_detail_prints_the_keys_as_the_built_error_object() {
        let gh = store_error::failure(&StoreError::Gh {
            failures: vec![PrFailure {
                slice: TicketId::parse("personal-abcd").expect("a valid ID"),
                pull_request: PullRequest::from_url("https://github.com/owner/app/pull/7")
                    .expect("a valid PR URL"),
                message: "gh failed".to_owned(),
            }],
        });
        let failure = Failure {
            code: "conflict",
            message: "Sync stopped.".to_owned(),
            field: Some("parent".to_owned()),
            files: Some(vec!["tickets/personal/personal-abcd-a.md".to_owned()]),
            pull_requests: gh.pull_requests,
            exit: Exit::Refused,
        };
        // Built key by key, as the error object was built before `Failure` derived `Serialize`,
        // so the bytes match in a build with and without serde_json's `preserve_order`.
        let mut error = json!({ "code": "conflict", "message": "Sync stopped." });
        error["field"] = json!("parent");
        error["files"] = json!(["tickets/personal/personal-abcd-a.md"]);
        error["pullRequests"] = json!([{
            "id": "personal-abcd",
            "repository": "owner/app",
            "number": 7,
            "url": "https://github.com/owner/app/pull/7",
            "message": "gh failed",
        }]);

        let response = Response::failure(true, &failure);

        assert_eq!(response.stderr, format!("{}\n", json!({ "error": error })));
    }

    #[test]
    fn failure_without_json_prints_the_message() {
        let failure = Failure {
            code: "notInitialized",
            message: "No store.".to_owned(),
            field: None,
            files: None,
            pull_requests: None,
            exit: Exit::Refused,
        };

        let response = Response::failure(false, &failure);

        assert_eq!(response.stdout, "");
        assert_eq!(response.stderr, "error: No store.\n");
    }

    #[test]
    fn failure_with_files_lists_them_beside_the_code() {
        let failure = Failure {
            code: "conflict",
            message: "Sync stopped.".to_owned(),
            field: None,
            files: Some(vec!["tickets/personal/personal-abcd-a.md".to_owned()]),
            pull_requests: None,
            exit: Exit::Refused,
        };

        let response = Response::failure(true, &failure);

        let printed: serde_json::Value =
            serde_json::from_str(&response.stderr).expect("the error is one JSON value");
        assert_eq!(
            printed["error"]["files"],
            json!(["tickets/personal/personal-abcd-a.md"])
        );
    }

    #[test]
    fn failure_with_a_field_names_it_beside_the_code() {
        let failure = Failure {
            code: "invalidTicket",
            message: "`parent` is wrong.".to_owned(),
            field: Some("parent".to_owned()),
            files: None,
            pull_requests: None,
            exit: Exit::Refused,
        };

        let response = Response::failure(true, &failure);

        let printed: serde_json::Value =
            serde_json::from_str(&response.stderr).expect("the error is one JSON value");
        assert_eq!(
            printed,
            json!({
                "error": {
                    "code": "invalidTicket",
                    "message": "`parent` is wrong.",
                    "field": "parent",
                }
            })
        );
    }
}
