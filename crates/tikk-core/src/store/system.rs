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

pub(crate) fn run_git(directory: &Path, arguments: &[&str]) -> Result<(), StoreError> {
    let mut command = Command::new("git");

    command.arg("-C").arg(directory).args(arguments);

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

    Ok(())
}

/// `uname -n` prints the host name on Linux and macOS, where a `hostname` program may be missing.
pub(crate) fn read_host_name() -> Result<String, StoreError> {
    let output = Command::new("uname").arg("-n").output().map_err(|error| {
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
