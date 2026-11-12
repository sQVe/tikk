use std::process::ExitCode;

use serde_json::{Value, json};

/// What a command prints when it succeeds: `json` with `--json`, else `text`.
pub(crate) struct Output {
    pub(crate) json: Value,
    pub(crate) text: String,
}

/// The exit codes of the CLI contract.
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

pub(crate) struct Failure {
    pub(crate) code: &'static str,
    pub(crate) message: String,
    pub(crate) exit: Exit,
}

/// Everything one run prints, and its exit code.
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
            let error = json!({ "error": { "code": failure.code, "message": failure.message } });

            format!("{error}\n")
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

    use super::{Exit, Failure, Output, Response};

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
    fn failure_without_json_prints_the_message() {
        let failure = Failure {
            code: "notInitialized",
            message: "No store.".to_owned(),
            exit: Exit::Refused,
        };

        let response = Response::failure(false, &failure);

        assert_eq!(response.stdout, "");
        assert_eq!(response.stderr, "error: No store.\n");
    }
}
