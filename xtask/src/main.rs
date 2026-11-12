mod boundaries;
mod check;
mod mock;
mod module_table;
mod mutation;
mod raw_values;
#[cfg(target_os = "linux")]
mod ruta;
#[cfg(target_os = "linux")]
mod scene;
mod source_files;
#[cfg(test)]
mod test_support;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

const USAGE: &str = "\
Usage:
  cargo xtask check [tidy|build]
  cargo xtask raw-values
  cargo xtask mock capture <scene>
  cargo xtask sandbox <command> [arguments]
  cargo xtask mutation changed <base> [--max-mutants N]
  cargo xtask mutation audit <file>... [--max-mutants N]";

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let root = workspace_root();

    run_task(&root, &arguments)
}

#[expect(
    clippy::print_stderr,
    reason = "usage and failures are the command's error output"
)]
fn run_task(root: &Path, arguments: &[String]) -> ExitCode {
    match arguments.split_first() {
        Some((task, rest)) if task == "check" => check::run(root, rest),
        Some((task, rest)) if task == "mutation" => mutation::run(root, rest),
        Some((task, rest)) if task == "mock" => mock::run(root, rest),
        Some((task, rest)) if task == "sandbox" => sandbox_status(root, rest),
        Some((task, rest)) if task == "raw-values" && rest.is_empty() => {
            match raw_values::check(root) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("{error:#}");
                    ExitCode::FAILURE
                }
            }
        }
        _ => {
            eprintln!("{USAGE}");
            ExitCode::FAILURE
        }
    }
}

fn workspace_root() -> PathBuf {
    let manifest_directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"));

    manifest_directory
        .parent()
        .expect("xtask lives one level below the workspace root")
        .to_path_buf()
}

#[cfg(target_os = "linux")]
#[expect(
    clippy::print_stderr,
    reason = "a sandbox failure is the command's error output"
)]
fn sandbox_status(root: &Path, arguments: &[String]) -> ExitCode {
    match ruta::sandbox(root, arguments) {
        Ok(status) => status,
        Err(error) => {
            eprintln!("{error:#}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(not(target_os = "linux"))]
#[expect(
    clippy::print_stderr,
    reason = "the refusal is the command's error output"
)]
fn sandbox_status(_root: &Path, _arguments: &[String]) -> ExitCode {
    eprintln!("The sandbox runs on Linux only.");
    ExitCode::FAILURE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_values_command_reports_the_scan_result_without_changing_source() {
        let root = crate::test_support::temporary_directory();
        let directory = root.path().join("crates/tikk-ui/src");
        std::fs::create_dir_all(&directory).expect("create UI source");
        let path = directory.join("scene.rs");

        for (source, expected) in [
            ("div().w(theme.sizing.row_height);", ExitCode::SUCCESS),
            ("div().w(px(3.0));", ExitCode::FAILURE),
        ] {
            std::fs::write(&path, source).expect("write source");

            assert_eq!(
                run_task(root.path(), &["raw-values".to_string()]),
                expected,
                "{source}"
            );
            assert_eq!(
                std::fs::read_to_string(&path).expect("read unchanged source"),
                source
            );
        }
    }

    #[test]
    fn run_task_refuses_missing_unknown_or_extra_arguments() {
        let root = crate::test_support::temporary_directory();
        let directory = root.path().join("crates/tikk-ui/src");
        std::fs::create_dir_all(&directory).expect("create a valid UI source tree");
        let path = directory.join("scene.rs");
        std::fs::write(&path, "theme.spacing.small").expect("write valid source");

        for arguments in [
            vec![],
            vec!["unknown".to_string()],
            vec!["raw-values".to_string(), "extra".to_string()],
        ] {
            assert_eq!(
                run_task(root.path(), &arguments),
                ExitCode::FAILURE,
                "{arguments:?}"
            );
            assert_eq!(
                std::fs::read_to_string(&path).expect("read untouched source"),
                "theme.spacing.small"
            );
            assert_eq!(
                std::fs::read_dir(root.path())
                    .expect("read untouched fixture")
                    .count(),
                1
            );
        }
    }
}
