use std::ffi::OsString;

use clap::error::ErrorKind;
use clap::{CommandFactory, Parser};
use serde_json::json;
use tikk_core::{StoreEffects, StoreError};

use crate::command::{Cli, Command};
use crate::init;
use crate::output::{Exit, Failure, Output, Response};
use crate::store_error;

const VERSION: &str = env!("CARGO_PKG_VERSION");

pub(crate) struct Environment {
    pub(crate) tikk_home: Option<OsString>,
    pub(crate) home: Option<OsString>,
    pub(crate) effects: StoreEffects,
}

impl Environment {
    pub(crate) fn system() -> Self {
        Self {
            tikk_home: std::env::var_os("TIKK_HOME"),
            home: std::env::var_os("HOME"),
            effects: StoreEffects::system(),
        }
    }
}

pub(crate) fn run(arguments: Vec<OsString>, environment: Environment) -> Response {
    let asks_for_json = asks_for_json(&arguments);
    let cli = match Cli::try_parse_from(arguments) {
        Ok(cli) => cli,
        Err(error) => return usage_response(asks_for_json, &error),
    };

    if cli.version {
        let output = Output {
            json: json!({ "version": VERSION }),
            text: format!("tikk {VERSION}"),
        };

        return Response::success(cli.json, &output);
    }

    let Some(command) = cli.command else {
        let error = Cli::command().error(ErrorKind::MissingSubcommand, "a command is required");

        return usage_response(cli.json, &error);
    };

    match run_command(command, environment) {
        Ok(output) => Response::success(cli.json, &output),
        Err(error) => Response::failure(cli.json, &store_error::failure(&error)),
    }
}

fn run_command(command: Command, environment: Environment) -> Result<Output, StoreError> {
    let store = tikk_core::store_path(environment.tikk_home, environment.home)?;

    match command {
        Command::Init { machine } => init::run(&store, machine, &environment.effects),
    }
}

fn asks_for_json(arguments: &[OsString]) -> bool {
    arguments
        .iter()
        .skip(1)
        .take_while(|argument| *argument != "--")
        .any(|argument| argument == "--json")
}

fn usage_response(json: bool, error: &clap::Error) -> Response {
    let rendered = error.render().to_string();

    if !error.use_stderr() {
        return Response {
            stdout: rendered,
            stderr: String::new(),
            exit: Exit::Success,
        };
    }

    if !json {
        return Response {
            stdout: String::new(),
            stderr: rendered,
            exit: Exit::WrongUsage,
        };
    }

    let message = rendered
        .lines()
        .next()
        .unwrap_or_default()
        .trim_start_matches("error: ")
        .to_owned();
    let failure = Failure {
        code: "invalidArguments",
        message,
        exit: Exit::WrongUsage,
    };

    Response::failure(true, &failure)
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::asks_for_json;

    fn arguments(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn asks_for_json_reads_the_flag_before_a_double_dash() {
        let cases = [
            (&["tikk", "init", "--json"][..], true),
            (&["tikk", "--json", "--bad"][..], true),
            (&["tikk", "init"][..], false),
            (&["tikk", "init", "--", "--json"][..], false),
            (&["--json"][..], false),
        ];

        for (values, expected) in cases {
            assert_eq!(
                asks_for_json(&arguments(values)),
                expected,
                "case {values:?}"
            );
        }
    }
}
