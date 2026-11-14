use std::path::Path;
use std::process::Command;

use crate::store::StoreError;

/// Git reads these before `-C`. A tikk started from a Git hook would otherwise write to the
/// hook's repository.
const REPOSITORY_ENVIRONMENT: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_COMMON_DIR",
];

pub(crate) fn run_git(directory: &Path, arguments: &[&str]) -> Result<String, StoreError> {
    run_git_with("git", directory, arguments)
}

fn run_git_with(program: &str, directory: &Path, arguments: &[&str]) -> Result<String, StoreError> {
    let mut command = Command::new(program);

    command.arg("-C").arg(directory).args(arguments);

    // Git stops looking for a repository at the store's parent, so it never finds another one.
    if let Some(parent) = directory.parent() {
        command.env("GIT_CEILING_DIRECTORIES", parent);
    }

    for name in REPOSITORY_ENVIRONMENT {
        command.env_remove(name);
    }

    let git_error = |message: String| StoreError::Git {
        arguments: arguments.join(" "),
        message,
    };
    let output = command
        .output()
        .map_err(|error| git_error(error.to_string()))?;

    if !output.status.success() {
        return Err(git_error(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }

    String::from_utf8(output.stdout)
        .map_err(|_| git_error("Git printed text that is not UTF-8".to_owned()))
}

/// `uname -n` prints the host name on Linux and macOS, where a `hostname` program may be missing.
pub(crate) fn read_host_name() -> Result<String, StoreError> {
    read_host_name_with("uname")
}

fn read_host_name_with(program: &str) -> Result<String, StoreError> {
    let output = Command::new(program).arg("-n").output().map_err(|error| {
        StoreError::HostNameUnavailable {
            message: format!("could not start uname: {error}"),
        }
    })?;

    if !output.status.success() {
        return Err(StoreError::HostNameUnavailable {
            message: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        });
    }

    String::from_utf8(output.stdout).map_err(|_| StoreError::HostNameUnavailable {
        message: "uname printed a name that is not UTF-8".to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use std::path::Path;

    use super::{read_host_name, read_host_name_with, run_git, run_git_with};
    use crate::store::StoreError;

    #[test]
    fn read_host_name_returns_what_uname_prints() {
        let uname = Command::new("uname")
            .arg("-n")
            .output()
            .expect("start uname");
        let expected = String::from_utf8(uname.stdout).expect("uname prints UTF-8");

        let host_name = read_host_name().expect("the host name is readable");

        assert!(!expected.trim().is_empty(), "uname printed no host name");
        assert_eq!(host_name, expected);
    }

    #[test]
    fn a_git_that_exits_nonzero_gives_a_git_error() {
        let directory = tempfile::tempdir().expect("create a temporary directory");

        let error =
            run_git_with("false", directory.path(), &["status"]).expect_err("the program fails");

        assert!(
            matches!(&error, StoreError::Git { arguments, .. } if arguments == "status"),
            "{error:?}"
        );
    }

    #[test]
    fn a_uname_that_exits_nonzero_gives_host_name_unavailable() {
        let error = read_host_name_with("false").expect_err("the program fails");

        assert!(
            matches!(error, StoreError::HostNameUnavailable { .. }),
            "{error:?}"
        );
    }

    #[test]
    fn run_git_never_reaches_a_parent_repository() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let parent = directory.path();
        run_git(parent, &["init", "--quiet"]).expect("init the parent repository");
        let child = parent.join("child");
        std::fs::create_dir(&child).expect("create the child folder");

        let result = run_git(Path::new(&child), &["rev-parse", "--git-dir"]);

        assert!(matches!(result, Err(StoreError::Git { .. })), "{result:?}");
    }
}
