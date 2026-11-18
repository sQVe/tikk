use std::ffi::OsString;
use std::path::Path;
use std::process::{Command, ExitCode};

use thiserror::Error;

use crate::raw_values;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Group {
    // Checks whose result does not depend on the operating system.
    Tidy,
    Build,
}

struct Step {
    name: &'static str,
    group: Group,
    program: &'static str,
    arguments: Vec<String>,
    environment: &'static [(&'static str, &'static str)],
}

const DENY_WARNINGS: (&str, &str) = ("CARGO_BUILD_WARNINGS", "deny");

fn build_step(
    name: &'static str,
    group: Group,
    program: &'static str,
    arguments: &[&str],
    environment: &'static [(&'static str, &'static str)],
) -> Step {
    Step {
        name,
        group,
        program,
        arguments: arguments
            .iter()
            .map(|argument| (*argument).to_string())
            .collect(),
        environment,
    }
}

fn build_stomme_step(base: Option<&str>) -> Step {
    let mut stomme = build_step(
        "stomme",
        Group::Tidy,
        "mise",
        &["exec", "--", "stomme", "check"],
        &[],
    );

    if let Some(base) = base {
        stomme
            .arguments
            .extend(["--base".to_string(), base.to_string()]);
    }

    stomme
}

fn build_steps(base: Option<&str>) -> Vec<Step> {
    vec![
        build_step(
            "rustfmt",
            Group::Tidy,
            "cargo",
            &["fmt", "--all", "--check"],
            &[],
        ),
        build_step("typos", Group::Tidy, "typos", &[], &[]),
        build_step(
            "taplo",
            Group::Tidy,
            "taplo",
            &["fmt", "--check"],
            &[("RUST_LOG", "warn")],
        ),
        build_step(
            "cargo-deny",
            Group::Tidy,
            "cargo",
            &["deny", "--locked", "check"],
            &[],
        ),
        build_step(
            "cargo-shear",
            Group::Tidy,
            "cargo",
            &["shear", "--locked", "--deny-warnings"],
            &[],
        ),
        build_stomme_step(base),
        build_step(
            "clippy",
            Group::Build,
            "cargo",
            &["clippy", "--workspace", "--all-targets", "--locked"],
            &[DENY_WARNINGS],
        ),
        build_step(
            "nextest",
            Group::Build,
            "cargo",
            &["nextest", "run", "--workspace", "--locked"],
            &[DENY_WARNINGS],
        ),
        build_step(
            "doctests",
            Group::Build,
            "cargo",
            &["test", "--doc", "--workspace", "--locked"],
            &[DENY_WARNINGS],
        ),
        build_step(
            "rustdoc",
            Group::Build,
            "cargo",
            &["doc", "--workspace", "--no-deps", "--locked"],
            &[DENY_WARNINGS, ("RUSTDOCFLAGS", "-D warnings")],
        ),
    ]
}

#[derive(Debug, Error, PartialEq, Eq)]
#[error("Unknown check arguments: {}. Use tidy, build, or none.", arguments.join(" "))]
struct UnknownArguments {
    arguments: Vec<String>,
}

fn parse_groups(arguments: &[String]) -> Result<Vec<Group>, UnknownArguments> {
    match arguments {
        [] => Ok(vec![Group::Tidy, Group::Build]),
        [group] if group == "tidy" => Ok(vec![Group::Tidy]),
        [group] if group == "build" => Ok(vec![Group::Build]),
        _ => Err(UnknownArguments {
            arguments: arguments.to_vec(),
        }),
    }
}

const STOMME_BASE: &str = "STOMME_BASE";
const RAW_VALUES: &str = "raw-values";

#[derive(Debug, Error, PartialEq, Eq)]
enum InvalidStommeBase {
    #[error("{variable} is not valid UTF-8")]
    NotUtf8 { variable: &'static str },
}

fn parse_stomme_base(value: Option<OsString>) -> Result<Option<String>, InvalidStommeBase> {
    let Some(value) = value else {
        return Ok(None);
    };

    let base = value
        .into_string()
        .map_err(|_| InvalidStommeBase::NotUtf8 {
            variable: STOMME_BASE,
        })?;

    Ok(Some(base).filter(|base| !base.is_empty()))
}

#[expect(
    clippy::print_stderr,
    reason = "check progress and failures are the command's output"
)]
fn run_step(root: &Path, step: &Step) -> bool {
    eprintln!("==> {}", step.name);

    let status = Command::new(step.program)
        .args(&step.arguments)
        .envs(step.environment.iter().copied())
        .current_dir(root)
        .status();

    match status {
        Ok(status) => status.success(),
        Err(error) => {
            eprintln!("Could not start {}: {error}", step.program);
            false
        }
    }
}

#[expect(
    clippy::print_stderr,
    reason = "raw-values progress and failures are the command's output"
)]
fn check_raw_values(root: &Path) -> bool {
    eprintln!("==> {RAW_VALUES}");

    match raw_values::check(root) {
        Ok(()) => true,
        Err(error) => {
            eprintln!("{error:#}");
            false
        }
    }
}

// Runs every selected step, even after a failure, so one run shows every problem.
fn failed_steps<'a>(root: &Path, steps: &'a [Step], groups: &[Group]) -> Vec<&'a str> {
    steps
        .iter()
        .filter(|step| groups.contains(&step.group))
        .filter(|step| !run_step(root, step))
        .map(|step| step.name)
        .collect()
}

fn failed_checks<'a>(root: &Path, steps: &'a [Step], groups: &[Group]) -> Vec<&'a str> {
    let mut failed = failed_steps(root, steps, groups);

    if groups.contains(&Group::Tidy) && !check_raw_values(root) {
        failed.push(RAW_VALUES);
    }

    failed
}

#[expect(
    clippy::print_stderr,
    reason = "check progress and failures are the command's output"
)]
fn check_steps(root: &Path, steps: &[Step], groups: &[Group]) -> ExitCode {
    let failed = failed_checks(root, steps, groups);

    if failed.is_empty() {
        eprintln!("All checks passed.");
        return ExitCode::SUCCESS;
    }

    eprintln!("Failed checks: {}", failed.join(", "));
    ExitCode::FAILURE
}

#[expect(
    clippy::print_stderr,
    reason = "invalid check arguments are the command's error output"
)]
fn run_with_environment(
    root: &Path,
    arguments: &[String],
    base_value: Option<OsString>,
    build: impl FnOnce(Option<&str>) -> Vec<Step>,
) -> ExitCode {
    let groups = match parse_groups(arguments) {
        Ok(groups) => groups,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };

    let base = match parse_stomme_base(base_value) {
        Ok(base) => base,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };

    check_steps(root, &build(base.as_deref()), &groups)
}

pub(crate) fn run(root: &Path, arguments: &[String]) -> ExitCode {
    run_with_environment(root, arguments, std::env::var_os(STOMME_BASE), build_steps)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn non_utf8_value() -> OsString {
        use std::os::unix::ffi::OsStringExt as _;

        OsString::from_vec(vec![0xff, 0xfe])
    }

    fn shell_step(arguments: &[&str]) -> Step {
        build_step("shell", Group::Tidy, "/bin/sh", arguments, &[])
    }

    #[test]
    fn check_steps_fails_when_a_step_fails_and_runs_later_steps() {
        let root = crate::test_support::temporary_directory();
        let steps = [
            Step {
                name: "fails",
                group: Group::Build,
                ..shell_step(&["-c", "exit 7"])
            },
            Step {
                name: "later",
                group: Group::Build,
                ..shell_step(&["-c", "touch later"])
            },
        ];

        assert_eq!(
            check_steps(root.path(), &steps, &[Group::Build]),
            ExitCode::FAILURE
        );
        assert!(root.path().join("later").exists());
    }

    #[test]
    fn check_steps_fails_when_a_program_is_missing() {
        let root = crate::test_support::temporary_directory();
        let steps = [Step {
            group: Group::Build,
            program: "/nonexistent/tikk-missing-program",
            ..shell_step(&[])
        }];

        assert_eq!(
            check_steps(root.path(), &steps, &[Group::Build]),
            ExitCode::FAILURE
        );
    }

    #[test]
    fn check_steps_passes_when_all_selected_steps_pass() {
        let root = crate::test_support::temporary_directory();
        let steps = [Step {
            group: Group::Build,
            ..shell_step(&["-c", "exit 0"])
        }];

        assert_eq!(
            check_steps(root.path(), &steps, &[Group::Build]),
            ExitCode::SUCCESS
        );
    }

    #[test]
    fn failed_steps_runs_every_selected_step_after_a_failure() {
        let root = crate::test_support::temporary_directory();
        let steps = [
            Step {
                name: "fails",
                ..shell_step(&["-c", "exit 1"])
            },
            Step {
                name: "later",
                ..shell_step(&["-c", "touch later"])
            },
            Step {
                name: "build",
                group: Group::Build,
                ..shell_step(&["-c", "touch build"])
            },
        ];

        assert_eq!(failed_steps(root.path(), &steps, &[Group::Tidy]), ["fails"]);
        assert!(root.path().join("later").exists());
        assert!(!root.path().join("build").exists());
    }

    #[test]
    fn run_step_runs_in_the_root_with_its_environment() {
        let root = crate::test_support::temporary_directory();
        let step = Step {
            environment: &[("TIKK_CHECK_VALUE", "expected")],
            ..shell_step(&[
                "-c",
                r#"test -f marker && test "$TIKK_CHECK_VALUE" = expected"#,
            ])
        };

        std::fs::write(root.path().join("marker"), "").expect("write marker");

        assert!(run_step(root.path(), &step));
    }

    #[test]
    fn parse_groups_selects_groups() {
        let cases = [
            (vec![], vec![Group::Tidy, Group::Build]),
            (vec!["tidy".to_string()], vec![Group::Tidy]),
            (vec!["build".to_string()], vec![Group::Build]),
        ];

        for (arguments, expected) in cases {
            assert_eq!(parse_groups(&arguments), Ok(expected), "{arguments:?}");
        }
    }

    #[test]
    fn parse_groups_rejects_unknown_arguments() {
        for arguments in [
            vec!["lint".to_string()],
            vec!["tidy".to_string(), "build".to_string()],
        ] {
            let error = parse_groups(&arguments).expect_err("unknown arguments fail");

            assert_eq!(error.arguments, arguments);
        }
    }

    #[test]
    fn run_fails_on_unknown_arguments() {
        let root = crate::test_support::temporary_directory();

        assert_eq!(run(root.path(), &["lint".to_string()]), ExitCode::FAILURE);
        assert_eq!(
            std::fs::read_dir(root.path())
                .expect("read fixture")
                .count(),
            0
        );
    }

    #[test]
    fn build_steps_group_every_command_check() {
        let names = |group| {
            build_steps(None)
                .iter()
                .filter(|step| step.group == group)
                .map(|step| step.name)
                .collect::<Vec<_>>()
        };

        assert_eq!(
            names(Group::Tidy),
            [
                "rustfmt",
                "typos",
                "taplo",
                "cargo-deny",
                "cargo-shear",
                "stomme"
            ]
        );
        assert_eq!(
            names(Group::Build),
            ["clippy", "nextest", "doctests", "rustdoc"]
        );
    }

    #[test]
    fn build_steps_gives_the_stomme_step_its_base() {
        let stomme = ["exec", "--", "stomme", "check"];
        let with_base = ["exec", "--", "stomme", "check", "--base", "origin/feature"];
        let cases: [(Option<OsString>, &[&str]); 3] = [
            (None, &stomme),
            (Some(OsString::new()), &stomme),
            (Some(OsString::from("origin/feature")), &with_base),
        ];

        for (value, expected) in cases {
            let base = parse_stomme_base(value.clone()).expect("the base is valid");
            let steps = build_steps(base.as_deref());
            let stomme_step = steps
                .iter()
                .find(|candidate| candidate.name == "stomme")
                .expect("the stomme step exists");

            assert_eq!(stomme_step.program, "mise", "{value:?}");
            assert_eq!(stomme_step.arguments, expected, "{value:?}");
            assert!(stomme_step.environment.is_empty(), "{value:?}");
            assert_eq!(steps[0].arguments, ["fmt", "--all", "--check"], "{value:?}");
        }
    }

    #[test]
    fn parse_stomme_base_rejects_a_non_utf8_value() {
        assert_eq!(
            parse_stomme_base(Some(non_utf8_value())),
            Err(InvalidStommeBase::NotUtf8 {
                variable: "STOMME_BASE"
            })
        );
    }

    #[test]
    fn run_with_environment_fails_on_a_non_utf8_base_before_any_step_runs() {
        let root = crate::test_support::temporary_directory();
        let build = |_base: Option<&str>| vec![shell_step(&["-c", "touch ran"])];

        assert_eq!(
            run_with_environment(root.path(), &[], Some(non_utf8_value()), build),
            ExitCode::FAILURE
        );
        assert!(!root.path().join("ran").exists());
    }

    #[test]
    fn run_with_environment_runs_the_steps_for_a_valid_base() {
        let root = crate::test_support::temporary_directory();
        let build = |base: Option<&str>| {
            assert_eq!(base, Some("origin/feature"));
            vec![Step {
                group: Group::Build,
                ..shell_step(&["-c", "touch ran"])
            }]
        };

        assert_eq!(
            run_with_environment(
                root.path(),
                &["build".to_string()],
                Some(OsString::from("origin/feature")),
                build
            ),
            ExitCode::SUCCESS
        );
        assert!(root.path().join("ran").exists());
    }

    #[test]
    fn build_steps_lock_cargo_and_deny_build_warnings() {
        for step in build_steps(None) {
            if step.program == "cargo" && step.name != "rustfmt" {
                assert!(
                    step.arguments.iter().any(|argument| argument == "--locked"),
                    "{} is locked",
                    step.name
                );
            }

            if step.group == Group::Build {
                assert!(
                    step.environment.contains(&DENY_WARNINGS),
                    "{} denies warnings",
                    step.name
                );
            }

            if step.name == "rustdoc" {
                assert!(step.environment.contains(&("RUSTDOCFLAGS", "-D warnings")));
            }
        }
    }

    #[test]
    fn check_steps_fails_a_tidy_run_on_a_raw_value_and_leaves_the_source() {
        let root = crate::test_support::temporary_directory();
        std::fs::create_dir_all(root.path().join("crates/tikk-ui/src"))
            .expect("create UI source folder");

        assert_eq!(
            check_steps(root.path(), &[], &[Group::Tidy]),
            ExitCode::SUCCESS
        );

        let scene = root.path().join("crates/tikk-ui/src/scene.rs");
        let source = "div().w(px(3.0));";
        std::fs::write(&scene, source).expect("write raw UI value");

        assert_eq!(
            check_steps(root.path(), &[], &[Group::Tidy]),
            ExitCode::FAILURE
        );
        assert_eq!(
            failed_checks(root.path(), &[], &[Group::Tidy]),
            ["raw-values"]
        );
        assert_eq!(
            std::fs::read_to_string(scene).expect("read unchanged UI source"),
            source
        );
    }

    #[test]
    fn check_steps_skips_raw_values_in_a_build_only_run() {
        let root = crate::test_support::temporary_directory();
        std::fs::create_dir_all(root.path().join("crates/tikk-ui/src"))
            .expect("create UI source folder");
        std::fs::write(
            root.path().join("crates/tikk-ui/src/scene.rs"),
            "div().w(px(3.0));",
        )
        .expect("write raw UI value");

        assert_eq!(
            check_steps(root.path(), &[], &[Group::Build]),
            ExitCode::SUCCESS
        );
    }

    #[test]
    fn run_step_fails_when_its_program_exits_non_zero() {
        let root = crate::test_support::temporary_directory();

        assert!(run_step(root.path(), &shell_step(&["-c", "exit 0"])));
        assert!(!run_step(root.path(), &shell_step(&["-c", "exit 7"])));
    }

    #[test]
    fn run_step_fails_when_its_program_does_not_exist() {
        let root = crate::test_support::temporary_directory();
        let step = Step {
            program: "/nonexistent/tikk-missing-program",
            ..shell_step(&[])
        };

        assert!(!run_step(root.path(), &step));
    }
}
