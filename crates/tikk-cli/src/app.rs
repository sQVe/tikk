use std::ffi::OsString;
use std::path::PathBuf;

use clap::error::ErrorKind;
use clap::{CommandFactory, Parser};
use serde_json::json;
use tikk_core::{
    AnswerEffects, AskEffects, AttentionEffects, AuditEffects, AuditRequest, ClaimEffects,
    EditEffects, Identity, PrEffects, QueryEffects, ReadyEffects, ReadyScope, RemoteInitEffects,
    StoreEffects, StoreError, SyncEffects, TicketEffects, WriteEffects,
};

use crate::command::{Cli, Command, PrCommand};
use crate::output::{Exit, Failure, Output, Response};
use crate::ready::ready_output;
use crate::ticket_row::written_output;
use crate::{audit, claim, edit, init, ls, needs, new, pr, question, show, store_error, sync};

const VERSION: &str = env!("CARGO_PKG_VERSION");

pub(crate) struct Environment {
    pub(crate) tikk_home: Option<OsString>,
    pub(crate) home: Option<OsString>,
    pub(crate) working_directory: PathBuf,
    pub(crate) editor: Option<OsString>,
    pub(crate) agent: Option<OsString>,
    pub(crate) session: Option<OsString>,
    pub(crate) session_log: Option<OsString>,
    pub(crate) effects: StoreEffects,
    pub(crate) ticket_effects: TicketEffects,
    pub(crate) query_effects: QueryEffects,
    pub(crate) write_effects: WriteEffects,
    pub(crate) edit_effects: EditEffects,
    pub(crate) claim_effects: ClaimEffects,
    pub(crate) ready_effects: ReadyEffects,
    pub(crate) pr_effects: PrEffects,
    pub(crate) audit_effects: AuditEffects,
    pub(crate) ask_effects: AskEffects,
    pub(crate) answer_effects: AnswerEffects,
    pub(crate) attention_effects: AttentionEffects,
    pub(crate) remote_init_effects: RemoteInitEffects,
    pub(crate) sync_effects: SyncEffects,
}

impl Environment {
    pub(crate) fn system() -> Self {
        Self {
            tikk_home: std::env::var_os("TIKK_HOME"),
            home: std::env::var_os("HOME"),
            // Git then reports the folder it cannot enter when it reads `origin`.
            working_directory: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            editor: std::env::var_os("EDITOR"),
            agent: std::env::var_os("TIKK_AGENT"),
            session: std::env::var_os("TIKK_SESSION"),
            session_log: std::env::var_os("TIKK_SESSION_LOG"),
            effects: StoreEffects::system(),
            ticket_effects: TicketEffects::system(),
            query_effects: QueryEffects::system(),
            write_effects: WriteEffects::system(),
            edit_effects: EditEffects::system(),
            claim_effects: ClaimEffects::system(),
            ready_effects: ReadyEffects::system(),
            pr_effects: PrEffects::system(),
            audit_effects: AuditEffects::system(),
            ask_effects: AskEffects::system(),
            answer_effects: AnswerEffects::system(),
            attention_effects: AttentionEffects::system(),
            remote_init_effects: RemoteInitEffects::system(),
            sync_effects: SyncEffects::system(),
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
    // Only the commands that act for the caller parse the identity, so a bad value stops no other.
    let caller = Identity::from_environment(
        environment.agent,
        environment.session,
        environment.session_log,
    );

    match command {
        Command::Init {
            machine,
            remote: None,
        } => init::run(&store, machine, &environment.effects),
        Command::Init {
            machine,
            remote: Some(remote),
        } => init::run_remote(
            &store,
            &init::RemoteLocation::resolve(&remote, &environment.working_directory)?,
            machine,
            &environment.remote_init_effects,
        ),
        Command::Sync => sync::run(&tikk_core::open(&store)?, &environment.sync_effects),
        Command::New(arguments) => new::run(
            &tikk_core::open(&store)?,
            arguments,
            environment.working_directory,
            caller?,
            &environment.ticket_effects,
        ),
        Command::Show { id } => {
            show::run(&tikk_core::open(&store)?, &id, &environment.query_effects)
        }
        Command::Ls(arguments) => ls::run(
            &tikk_core::open(&store)?,
            arguments,
            &environment.query_effects,
        ),
        Command::Write { id, file, hash } => tikk_core::write_ticket(
            &tikk_core::open(&store)?,
            tikk_core::TicketWrite { id, file, hash },
            &environment.write_effects,
        )
        .map(|written| written_output(&written)),
        Command::Edit { id } => edit::run(
            &tikk_core::open(&store)?,
            &id,
            environment.editor.as_deref(),
            &environment.edit_effects,
        ),
        Command::Done { id } => tikk_core::mark_done(
            &tikk_core::open(&store)?,
            &id,
            &caller?,
            &environment.write_effects,
        )
        .map(|done| written_output(&done)),
        Command::Cancel { id, reason } => tikk_core::cancel_ticket(
            &tikk_core::open(&store)?,
            &id,
            &reason,
            &caller?,
            &environment.write_effects,
        )
        .map(|canceled| written_output(&canceled)),
        Command::Block { id, blocker } => tikk_core::block_ticket(
            &tikk_core::open(&store)?,
            &id,
            &blocker,
            &environment.write_effects,
        )
        .map(|blocked| written_output(&blocked)),
        Command::Unblock { id, blocker } => tikk_core::unblock_ticket(
            &tikk_core::open(&store)?,
            &id,
            &blocker,
            &environment.write_effects,
        )
        .map(|unblocked| written_output(&unblocked)),
        Command::Move { id, new_parent } => tikk_core::move_ticket(
            &tikk_core::open(&store)?,
            &id,
            new_parent.parent.as_ref(),
            &environment.write_effects,
        )
        .map(|moved| written_output(&moved)),
        Command::Rank { id, place } => tikk_core::rank_ticket(
            &tikk_core::open(&store)?,
            &id,
            &place.place(),
            &environment.write_effects,
        )
        .map(|ranked| written_output(&ranked)),
        Command::Claim { id } => claim::run_claim(
            &tikk_core::open(&store)?,
            &id,
            &caller?,
            &environment.claim_effects,
        ),
        Command::Release { id } => claim::run_release(
            &tikk_core::open(&store)?,
            &id,
            &caller?,
            &environment.claim_effects,
        ),
        Command::Ready(arguments) => tikk_core::ready_slices(
            &tikk_core::open(&store)?,
            ReadyScope {
                parent: arguments.parent,
                project: arguments.project,
                working_directory: environment.working_directory,
            },
            &environment.ready_effects,
        )
        .map(|queue| ready_output(&queue)),
        Command::Audit(arguments) => audit::run(
            &tikk_core::open(&store)?,
            &AuditRequest {
                slice: arguments.id,
                hash: arguments.hash,
                head: arguments.head,
                file: arguments.file,
                repository: arguments.repository,
                working_directory: environment.working_directory,
            },
            &caller?,
            &environment.audit_effects,
        ),
        Command::Ask { id, text } => question::run_ask(
            &tikk_core::open(&store)?,
            &id,
            &text,
            &caller?,
            &environment.ask_effects,
        ),
        Command::Answer { id, item, text } => question::run_answer(
            &tikk_core::open(&store)?,
            &id,
            &item,
            &text,
            &environment.answer_effects,
        ),
        Command::Needs => needs::run(&tikk_core::open(&store)?, &environment.attention_effects),
        Command::Pr {
            command: PrCommand::Link { id, url },
        } => pr::run_link(
            &tikk_core::open(&store)?,
            &id,
            &url,
            &caller?,
            &environment.pr_effects,
        ),
        Command::Pr {
            command: PrCommand::Refresh { id },
        } => pr::run_refresh(
            &tikk_core::open(&store)?,
            id.as_ref(),
            &environment.pr_effects,
        ),
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
        .take_while(|line| !line.trim().is_empty())
        .map(str::trim)
        .collect::<Vec<_>>()
        .join(" ")
        .trim_start_matches("error: ")
        .to_owned();
    let failure = Failure {
        code: "invalidArguments",
        message,
        field: None,
        files: None,
        pull_requests: None,
        exit: Exit::WrongUsage,
    };

    Response::failure(true, &failure)
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::path::Path;
    use std::time::{Duration, SystemTime};

    use serde_json::{Value, json};
    use tikk_core::{MachineName, StoreEffects, StoreError, SyncEffects};

    use super::{Environment, asks_for_json, run};
    use crate::output::Exit;

    fn origin(_: &Path) -> Result<Option<String>, StoreError> {
        Ok(Some("git@example.com:owner/tikk-store.git".to_owned()))
    }

    fn timed_out(_: &Path, arguments: &[&str]) -> Result<Vec<u8>, StoreError> {
        Err(StoreError::GitTimeout {
            arguments: arguments.join(" "),
            timeout: Duration::from_secs(30),
        })
    }

    fn an_hour_later() -> SystemTime {
        SystemTime::now() + Duration::from_secs(3600)
    }

    #[test]
    fn sync_with_a_fetch_that_times_out_commits_and_exits_with_0() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let store = directory.path().join("store");
        let machine = MachineName::parse("laptop").expect("a valid machine name");
        tikk_core::init(&store, Some(machine), &StoreEffects::system()).expect("init the store");
        std::fs::create_dir_all(store.join("tickets/personal")).expect("create a project");
        std::fs::write(
            store.join("tickets/personal/personal-abcd-renew.md"),
            "---\nkind: task\ntitle: Renew\n---\n",
        )
        .expect("write a ticket");
        let mut environment = Environment::system();
        environment.tikk_home = Some(store.into_os_string());
        environment.sync_effects = SyncEffects {
            read_origin: origin,
            run_network_git: timed_out,
            now: an_hour_later,
            ..SyncEffects::system()
        };

        let response = run(arguments(&["tikk", "sync", "--json"]), environment);

        assert_eq!(response.exit, Exit::Success, "{}", response.stderr);
        let result: Value = serde_json::from_str(&response.stdout).expect("one JSON value");
        assert_eq!(result["committed"], json!(true));
        assert_eq!(result["fetched"], json!(false));
        assert_eq!(result["merged"], json!(false));
        assert_eq!(result["pushed"], json!(false));
        assert_eq!(result["problems"][0]["step"], json!("fetch"));
        assert!(
            result["problems"][0]["message"]
                .as_str()
                .is_some_and(|message| message.contains("did not finish within 30 seconds")),
            "{result}"
        );
    }

    #[test]
    fn claim_with_a_fetch_that_times_out_exits_with_0_and_saves_the_failed_fetch() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let store = directory.path().join("store");
        let machine = MachineName::parse("laptop").expect("a valid machine name");
        tikk_core::init(&store, Some(machine), &StoreEffects::system()).expect("init the store");
        std::fs::create_dir_all(store.join("tickets/personal")).expect("create a project");
        for (name, text) in [
            (
                "personal-pppp-plan.md",
                "---\nkind: plan\ntitle: Plan\n---\n",
            ),
            (
                "personal-kkkk-slice.md",
                "---\nkind: slice\ntitle: Slice\nparent: personal-pppp\ncriteria:\n  - id: s1\n    check: c\n    expected: e\n---\n",
            ),
        ] {
            std::fs::write(store.join("tickets/personal").join(name), text)
                .expect("write a ticket");
        }
        let mut environment = Environment::system();
        environment.tikk_home = Some(store.clone().into_os_string());
        environment.agent = Some(OsString::from("manager"));
        environment.claim_effects.sync = SyncEffects {
            read_origin: origin,
            run_network_git: timed_out,
            ..SyncEffects::system()
        };

        let response = run(
            arguments(&["tikk", "claim", "personal-kkkk", "--json"]),
            environment,
        );

        assert_eq!(response.exit, Exit::Success, "{}", response.stderr);
        let result: Value = serde_json::from_str(&response.stdout).expect("one JSON value");
        let saved: Value = serde_json::from_str(
            &std::fs::read_to_string(store.join(".git/tikk-sync.json"))
                .expect("read the saved result"),
        )
        .expect("the saved result is JSON");
        assert_eq!(result["claim"]["agent"], json!("manager"));
        for (name, sync) in [("sync field", &result["sync"]), ("saved result", &saved)] {
            assert_eq!(sync["fetched"], json!(false), "{name}: {sync}");
            assert_eq!(
                sync["problems"][0]["step"],
                json!("fetch"),
                "{name}: {sync}"
            );
            assert!(
                sync["problems"][0]["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("did not finish within 30 seconds")),
                "{name}: {sync}"
            );
        }
    }

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
