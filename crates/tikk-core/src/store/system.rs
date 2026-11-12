use std::ffi::OsStr;
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

// Returns Git's standard output as bytes, since a path it prints need not be UTF-8.
pub(crate) fn run_git(directory: &Path, arguments: &[&str]) -> Result<Vec<u8>, StoreError> {
    run_git_with("git", directory, arguments)
}

fn run_git_with(
    program: &str,
    directory: &Path,
    arguments: &[&str],
) -> Result<Vec<u8>, StoreError> {
    let mut command = git_command(program, directory, arguments);

    // Git stops looking for a repository at the store's parent, so it never finds another one.
    if let Some(parent) = directory.parent() {
        command.env("GIT_CEILING_DIRECTORIES", parent);
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

    Ok(output.stdout)
}

pub(crate) fn read_origin_url(directory: &Path) -> Result<Option<String>, StoreError> {
    read_origin_url_with("git", directory)
}

fn read_origin_url_with(program: &str, directory: &Path) -> Result<Option<String>, StoreError> {
    let arguments = ["config", "--get", "remote.origin.url"];
    let git_error = |message: String| StoreError::Git {
        arguments: arguments.join(" "),
        message,
    };
    let mut command = git_command(program, directory, &arguments);

    // Only the repository's own config names its origin. A global or system `origin`, or one
    // passed in the environment, belongs to no repository.
    command
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env_remove("GIT_CONFIG")
        .env_remove("GIT_CONFIG_COUNT")
        .env_remove("GIT_CONFIG_PARAMETERS");

    let output = command
        .output()
        .map_err(|error| git_error(error.to_string()))?;
    let url = String::from_utf8(output.stdout)
        .map_err(|_| git_error("Git printed text that is not UTF-8".to_owned()))?;

    match output.status.code() {
        Some(0) => Ok(Some(url.trim().to_owned())),
        Some(1) => Ok(None),
        _ => Err(git_error(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        )),
    }
}

fn git_command(program: &str, directory: &Path, arguments: &[&str]) -> Command {
    let mut command = Command::new(program);

    command.arg("-C").arg(directory).args(arguments);

    for name in REPOSITORY_ENVIRONMENT {
        command.env_remove(name);
    }

    command
}

/// The shell splits `EDITOR` into words, so an editor with arguments, such as `code --wait`,
/// works.
pub(crate) fn start_editor(editor: &OsStr, path: &Path) -> Result<(), StoreError> {
    let status = Command::new("sh")
        .arg("-c")
        .arg("$EDITOR \"$1\"")
        .arg("sh")
        .arg(path)
        .env("EDITOR", editor)
        .status()
        .map_err(|error| StoreError::EditorFailed {
            message: format!("could not start sh: {error}"),
        })?;

    if !status.success() {
        return Err(StoreError::EditorFailed {
            message: format!("it ended with {status}"),
        });
    }

    Ok(())
}

pub(crate) fn fill_random(buffer: &mut [u8]) -> Result<(), StoreError> {
    getrandom::fill(buffer).map_err(|error| StoreError::RandomUnavailable {
        message: error.to_string(),
    })
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

    use super::{
        fill_random, read_host_name, read_host_name_with, read_origin_url, read_origin_url_with,
        run_git, run_git_with, start_editor,
    };
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

    #[test]
    fn read_origin_url_finds_the_repository_above_the_directory() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let repository = directory.path();
        run_git(repository, &["init", "--quiet"]).expect("init a repository");
        run_git(
            repository,
            &["remote", "add", "origin", "git@github.com:owner/Tikk.git"],
        )
        .expect("add origin");
        let child = repository.join("src/deep");
        std::fs::create_dir_all(&child).expect("create a child folder");

        let url = read_origin_url(&child).expect("Git runs");

        assert_eq!(url.as_deref(), Some("git@github.com:owner/Tikk.git"));
    }

    #[test]
    fn read_origin_url_is_none_without_an_origin() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        run_git(directory.path(), &["init", "--quiet"]).expect("init a repository");

        let url = read_origin_url(directory.path()).expect("Git runs");

        assert_eq!(url, None);
    }

    #[test]
    fn read_origin_url_reports_a_git_that_cannot_start() {
        let directory = tempfile::tempdir().expect("create a temporary directory");

        let error = read_origin_url_with("tikk-test-no-such-program", directory.path())
            .expect_err("the program does not exist");

        assert!(
            matches!(&error, StoreError::Git { arguments, .. } if arguments == "config --get remote.origin.url"),
            "{error:?}"
        );
    }

    #[test]
    fn read_origin_url_reports_a_directory_git_cannot_enter() {
        let directory = tempfile::tempdir().expect("create a temporary directory");

        let error = read_origin_url(&directory.path().join("missing"))
            .expect_err("Git cannot change to a missing folder");

        assert!(matches!(error, StoreError::Git { .. }), "{error:?}");
    }

    #[test]
    fn fill_random_fills_the_buffer() {
        let mut first = [0u8; 32];
        let mut second = [0u8; 32];

        fill_random(&mut first).expect("the operating system gives random bytes");
        fill_random(&mut second).expect("the operating system gives random bytes");

        assert_ne!(first, second);
    }

    #[test]
    fn start_editor_reports_an_editor_that_fails() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let path = directory.path().join("ticket.md");

        let passed = start_editor(std::ffi::OsStr::new("true"), &path);
        let failed = start_editor(std::ffi::OsStr::new("false"), &path);

        assert!(passed.is_ok(), "{passed:?}");
        assert!(
            matches!(&failed, Err(StoreError::EditorFailed { message }) if message.contains("exit status: 1")),
            "{failed:?}"
        );
    }
}
