use std::path::Path;
use std::process::{Command, ExitCode};

use thiserror::Error;

use crate::{boundaries, module_table, raw_values};

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
    arguments: &'static [&'static str],
    environment: &'static [(&'static str, &'static str)],
}

const DENY_WARNINGS: (&str, &str) = ("CARGO_BUILD_WARNINGS", "deny");

const STEPS: &[Step] = &[
    Step {
        name: "rustfmt",
        group: Group::Tidy,
        program: "cargo",
        arguments: &["fmt", "--all", "--check"],
        environment: &[],
    },
    Step {
        name: "typos",
        group: Group::Tidy,
        program: "typos",
        arguments: &[],
        environment: &[],
    },
    Step {
        name: "taplo",
        group: Group::Tidy,
        program: "taplo",
        arguments: &["fmt", "--check"],
        environment: &[("RUST_LOG", "warn")],
    },
    Step {
        name: "cargo-deny",
        group: Group::Tidy,
        program: "cargo",
        arguments: &["deny", "--locked", "check"],
        environment: &[],
    },
    Step {
        name: "cargo-shear",
        group: Group::Tidy,
        program: "cargo",
        arguments: &["shear", "--locked", "--deny-warnings"],
        environment: &[],
    },
    Step {
        name: "clippy",
        group: Group::Build,
        program: "cargo",
        arguments: &["clippy", "--workspace", "--all-targets", "--locked"],
        environment: &[DENY_WARNINGS],
    },
    Step {
        name: "nextest",
        group: Group::Build,
        program: "cargo",
        arguments: &["nextest", "run", "--workspace", "--locked"],
        environment: &[DENY_WARNINGS],
    },
    Step {
        name: "doctests",
        group: Group::Build,
        program: "cargo",
        arguments: &["test", "--doc", "--workspace", "--locked"],
        environment: &[DENY_WARNINGS],
    },
    Step {
        name: "rustdoc",
        group: Group::Build,
        program: "cargo",
        arguments: &["doc", "--workspace", "--no-deps", "--locked"],
        environment: &[DENY_WARNINGS, ("RUSTDOCFLAGS", "-D warnings")],
    },
];

type SourceCheck = fn(&Path) -> anyhow::Result<()>;

const SOURCE_CHECKS: &[(&str, SourceCheck)] = &[
    ("crate-boundaries", boundaries::check),
    ("module-table", module_table::check),
    ("raw-values", raw_values::check),
];

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

#[expect(
    clippy::print_stderr,
    reason = "check progress and failures are the command's output"
)]
fn run_step(root: &Path, step: &Step) -> bool {
    eprintln!("==> {}", step.name);

    let status = Command::new(step.program)
        .args(step.arguments)
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
    reason = "source check progress and failures are the command's output"
)]
fn failed_source_checks(root: &Path) -> Vec<&'static str> {
    let mut failed = Vec::new();

    for (name, source_check) in SOURCE_CHECKS {
        eprintln!("==> {name}");

        if let Err(error) = source_check(root) {
            eprintln!("{error:#}");
            failed.push(*name);
        }
    }

    failed
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

#[expect(
    clippy::print_stderr,
    reason = "check progress and failures are the command's output"
)]
fn check_steps(root: &Path, steps: &[Step], groups: &[Group]) -> ExitCode {
    let mut failed = failed_steps(root, steps, groups);

    if groups.contains(&Group::Tidy) {
        failed.extend(failed_source_checks(root));
    }

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
pub(crate) fn run(root: &Path, arguments: &[String]) -> ExitCode {
    let groups = match parse_groups(arguments) {
        Ok(groups) => groups,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };

    check_steps(root, STEPS, &groups)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell_step(arguments: &'static [&'static str]) -> Step {
        Step {
            name: "shell",
            group: Group::Tidy,
            program: "/bin/sh",
            arguments,
            environment: &[],
        }
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
    fn steps_group_every_command_check() {
        let names = |group| {
            STEPS
                .iter()
                .filter(|step| step.group == group)
                .map(|step| step.name)
                .collect::<Vec<_>>()
        };

        assert_eq!(
            names(Group::Tidy),
            ["rustfmt", "typos", "taplo", "cargo-deny", "cargo-shear"]
        );
        assert_eq!(
            names(Group::Build),
            ["clippy", "nextest", "doctests", "rustdoc"]
        );
    }

    #[test]
    fn steps_lock_cargo_and_deny_build_warnings() {
        for step in STEPS {
            if step.program == "cargo" && step.name != "rustfmt" {
                assert!(
                    step.arguments.contains(&"--locked"),
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

    fn source_folders() -> tempfile::TempDir {
        let root = crate::test_support::temporary_directory();

        std::fs::create_dir_all(root.path().join("crates/tikk-ui/src"))
            .expect("create UI source folder");
        std::fs::create_dir_all(root.path().join("crates/tikk-core/src"))
            .expect("create core source folder");

        root
    }

    fn workspace_with_valid_metadata() -> tempfile::TempDir {
        let root = source_folders();

        std::fs::create_dir(root.path().join("src")).expect("create source folder");
        std::fs::write(root.path().join("src/lib.rs"), "").expect("write library");
        std::fs::write(root.path().join("Cargo.toml"),
            "[workspace]\n[package]\nname = \"tikk-core\"\nversion = \"0.0.0\"\nedition = \"2024\"\n"
        ).expect("write manifest");
        let status = Command::new("cargo")
            .args(["generate-lockfile", "--offline"])
            .current_dir(root.path())
            .status()
            .expect("start cargo to prepare fixture");

        assert!(status.success());

        root
    }

    #[test]
    fn tidy_passes_when_boundary_metadata_has_no_violations() {
        let root = workspace_with_valid_metadata();

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
            std::fs::read_to_string(scene).expect("read unchanged UI source"),
            source
        );
    }

    #[test]
    fn tidy_fails_when_a_module_uses_a_forbidden_module() {
        let root = workspace_with_valid_metadata();
        let ticket = root.path().join("crates/tikk-core/src/ticket.rs");
        std::fs::write(&ticket, "use crate::store::read;\n").expect("write forbidden use");

        assert_eq!(
            check_steps(root.path(), &[], &[Group::Tidy]),
            ExitCode::FAILURE
        );

        std::fs::write(&ticket, "").expect("remove forbidden use");

        assert_eq!(
            check_steps(root.path(), &[], &[Group::Tidy]),
            ExitCode::SUCCESS
        );
    }

    #[test]
    fn tidy_fails_when_boundary_metadata_cannot_be_read() {
        let root = source_folders();

        assert_eq!(
            check_steps(root.path(), &[], &[Group::Tidy]),
            ExitCode::FAILURE
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
