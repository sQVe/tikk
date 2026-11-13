use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use crate::fact::Timestamp;
use crate::store::StoreError;

/// Writers wait at most five seconds for the store lock, so the network steps run outside it, and
/// each gives up after this long.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
const NETWORK_POLL: Duration = Duration::from_millis(20);

/// Settings for every Git call of sync and `init --remote`. Hooks, signing, and an autostash could
/// run a program, prompt, or move local changes, so each one is off. They override the global
/// config that the network steps keep for credential helpers and URL rewrites.
const STORE_SETTINGS: &[&str] = &[
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "tag.gpgSign=false",
    "-c",
    "merge.autoStash=false",
    "-c",
    "merge.ff=true",
];
const IDENTITY: &[(&str, &str)] = &[
    ("GIT_AUTHOR_NAME", "tikk"),
    ("GIT_AUTHOR_EMAIL", "tikk@localhost"),
    ("GIT_COMMITTER_NAME", "tikk"),
    ("GIT_COMMITTER_EMAIL", "tikk@localhost"),
];

/// Git reads these before `-C`. A tikk started from a Git hook would otherwise write to the
/// hook's repository.
const REPOSITORY_ENVIRONMENT: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_COMMON_DIR",
];

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

/// Runs a local Git step of sync or `init --remote` in the store, with no hook, prompt, or config
/// outside the repository.
pub(crate) fn run_store_git(directory: &Path, arguments: &[&str]) -> Result<Vec<u8>, StoreError> {
    let git_error = |message: String| StoreError::Git {
        arguments: arguments.join(" "),
        message,
    };
    let output = store_git_command("git", directory, arguments)
        .output()
        .map_err(|error| git_error(error.to_string()))?;

    if !output.status.success() {
        return Err(git_error(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }

    Ok(output.stdout)
}

/// Runs a Git step that reaches the remote, and stops it after the network timeout.
pub(crate) fn run_network_git(directory: &Path, arguments: &[&str]) -> Result<Vec<u8>, StoreError> {
    run_git_within("git", directory, arguments, NETWORK_TIMEOUT)
}

/// Reads the store's own `origin`. Git exits with 1 when the key is missing.
pub(crate) fn read_store_origin(root: &Path) -> Result<Option<String>, StoreError> {
    let arguments = ["config", "--get", "remote.origin.url"];
    let git_error = |message: String| StoreError::Git {
        arguments: arguments.join(" "),
        message,
    };
    let output = store_git_command("git", root, &arguments)
        .output()
        .map_err(|error| git_error(error.to_string()))?;

    match output.status.code() {
        Some(0) => String::from_utf8(output.stdout)
            .map(|url| Some(url.trim().to_owned()))
            .map_err(|_| git_error("Git printed text that is not UTF-8".to_owned())),
        Some(1) => Ok(None),
        _ => Err(git_error(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        )),
    }
}

/// A local step reads only the repository's own config.
fn store_git_command(program: &str, directory: &Path, arguments: &[&str]) -> Command {
    let mut command = network_git_command(program, directory, arguments);

    command
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1");

    command
}

/// A network step keeps the global and system config, so the user's credential helper reaches a
/// private remote.
fn network_git_command(program: &str, directory: &Path, arguments: &[&str]) -> Command {
    let mut command = Command::new(program);

    command
        .arg("-C")
        .arg(directory)
        .args(STORE_SETTINGS)
        .args(arguments)
        .stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .envs(IDENTITY.iter().copied())
        .env_remove("GIT_CONFIG")
        .env_remove("GIT_CONFIG_COUNT")
        .env_remove("GIT_CONFIG_PARAMETERS");

    for name in REPOSITORY_ENVIRONMENT {
        command.env_remove(name);
    }

    if let Some(parent) = directory.parent() {
        command.env("GIT_CEILING_DIRECTORIES", parent);
    }

    command
}

/// Output goes to files, not pipes, so a full pipe never blocks the wait. Only the Git child is
/// stopped at the timeout; a program it started may outlive it.
fn run_git_within(
    program: &str,
    directory: &Path,
    arguments: &[&str],
    timeout: Duration,
) -> Result<Vec<u8>, StoreError> {
    let git_error = |message: String| StoreError::Git {
        arguments: arguments.join(" "),
        message,
    };
    let capture = || {
        tempfile::tempfile()
            .map_err(|error| git_error(format!("could not capture output: {error}")))
    };
    let mut stdout = capture()?;
    let mut stderr = capture()?;
    let mut command = network_git_command(program, directory, arguments);

    command
        .stdout(clone_capture(&stdout).map_err(git_error)?)
        .stderr(clone_capture(&stderr).map_err(git_error)?);

    let child = command
        .spawn()
        .map_err(|error| git_error(error.to_string()))?;
    let status = wait_within(child, timeout).map_err(|failure| match failure {
        WaitFailure::TimedOut => StoreError::GitTimeout {
            arguments: arguments.join(" "),
            timeout,
        },
        WaitFailure::Failed(message) => git_error(message),
    })?;

    if !status.success() {
        let message = read_capture(&mut stderr).map_err(git_error)?;

        return Err(git_error(
            String::from_utf8_lossy(&message).trim().to_owned(),
        ));
    }

    read_capture(&mut stdout).map_err(git_error)
}

enum WaitFailure {
    TimedOut,
    Failed(String),
}

fn wait_within(mut child: Child, timeout: Duration) -> Result<ExitStatus, WaitFailure> {
    let deadline = Instant::now() + timeout;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(NETWORK_POLL),
            Ok(None) => return Err(stop(&mut child, WaitFailure::TimedOut)),
            Err(error) => {
                return Err(stop(
                    &mut child,
                    WaitFailure::Failed(format!("could not wait for Git: {error}")),
                ));
            }
        }
    }
}

/// Kills and reaps the child. A failure to stop it replaces the reason, since Git may still run.
fn stop(child: &mut Child, reason: WaitFailure) -> WaitFailure {
    if let Err(error) = child.kill() {
        return WaitFailure::Failed(format!("could not stop Git: {error}"));
    }

    match child.wait() {
        Ok(_) => reason,
        Err(error) => WaitFailure::Failed(format!("could not reap Git: {error}")),
    }
}

fn clone_capture(file: &File) -> Result<File, String> {
    file.try_clone()
        .map_err(|error| format!("could not capture output: {error}"))
}

fn read_capture(file: &mut File) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();

    file.seek(SeekFrom::Start(0))
        .and_then(|_| file.read_to_end(&mut bytes))
        .map_err(|error| format!("could not read the output: {error}"))?;

    Ok(bytes)
}

fn git_command(program: &str, directory: &Path, arguments: &[&str]) -> Command {
    let mut command = Command::new(program);

    command.arg("-C").arg(directory).args(arguments);

    for name in REPOSITORY_ENVIRONMENT {
        command.env_remove(name);
    }

    command
}

pub(crate) fn start_editor(
    program: &OsStr,
    arguments: &[OsString],
    path: &Path,
) -> Result<(), StoreError> {
    let status = Command::new(program)
        .args(arguments)
        .arg(path)
        .status()
        .map_err(|error| StoreError::EditorFailed {
            message: format!("could not start {}: {error}", program.to_string_lossy()),
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

pub(crate) fn now() -> Timestamp {
    Timestamp::from_system_time(SystemTime::now())
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
        fill_random, network_git_command, read_host_name, read_host_name_with, read_origin_url,
        read_origin_url_with, read_store_origin, run_git, run_git_with, run_git_within,
        run_store_git, start_editor, store_git_command,
    };
    use crate::store::StoreError;

    /// Writes an executable script that stands in for Git and ignores its arguments.
    fn fake_git(folder: &Path, body: &str) -> String {
        use std::os::unix::fs::PermissionsExt as _;

        let path = folder.join("fake-git");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write the script");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("make the script executable");

        path.to_str().expect("a UTF-8 path").to_owned()
    }

    /// What a fake Git sees: its arguments, then the config and prompt variables.
    fn seen_by_git(command: &mut Command) -> String {
        let output = command.output().expect("start the script");

        String::from_utf8(output.stdout).expect("the script prints UTF-8")
    }

    #[test]
    fn local_steps_drop_the_global_config_and_network_steps_keep_it() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let program = fake_git(
            directory.path(),
            "echo \"$*|${GIT_CONFIG_GLOBAL-unset}|${GIT_CONFIG_NOSYSTEM-unset}|$GIT_TERMINAL_PROMPT\"",
        );
        let settings = "-c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgSign=false -c tag.gpgSign=false -c merge.autoStash=false -c merge.ff=true";

        let local = seen_by_git(&mut store_git_command(
            &program,
            directory.path(),
            &["merge"],
        ));
        let network = seen_by_git(&mut network_git_command(
            &program,
            directory.path(),
            &["fetch"],
        ));

        let folder = directory.path().display();
        assert_eq!(
            local,
            format!("-C {folder} {settings} merge|/dev/null|1|0\n")
        );
        assert_eq!(
            network,
            format!("-C {folder} {settings} fetch|unset|unset|0\n")
        );
    }

    #[test]
    fn a_network_step_that_runs_too_long_is_stopped_with_a_timeout() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let program = fake_git(directory.path(), "sleep 10");
        let started = std::time::Instant::now();

        let error = run_git_within(
            &program,
            directory.path(),
            &["fetch", "origin"],
            std::time::Duration::from_millis(100),
        )
        .expect_err("the step runs too long");

        assert!(
            matches!(&error, StoreError::GitTimeout { arguments, .. } if arguments == "fetch origin"),
            "{error:?}"
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn a_network_step_returns_its_output_or_its_error_text() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let timeout = std::time::Duration::from_secs(10);
        let passing = fake_git(directory.path(), "echo fetched; echo noise >&2");

        let output = run_git_within(&passing, directory.path(), &["fetch"], timeout);

        assert_eq!(output.expect("the step passes"), b"fetched\n");
        let failing = fake_git(directory.path(), "echo rejected >&2; exit 1");
        let error = run_git_within(&failing, directory.path(), &["push"], timeout)
            .expect_err("the step fails");
        assert!(
            matches!(&error, StoreError::Git { message, .. } if message == "rejected"),
            "{error:?}"
        );
    }

    #[test]
    fn a_network_step_reports_a_git_that_cannot_start() {
        let directory = tempfile::tempdir().expect("create a temporary directory");

        let error = run_git_within(
            "tikk-test-no-such-program",
            directory.path(),
            &["fetch"],
            std::time::Duration::from_secs(1),
        )
        .expect_err("the program does not exist");

        assert!(matches!(error, StoreError::Git { .. }), "{error:?}");
    }

    #[test]
    fn read_store_origin_reads_only_the_store_itself() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let parent = directory.path();
        run_store_git(parent, &["init", "--quiet"]).expect("init the parent repository");
        run_store_git(parent, &["remote", "add", "origin", "/elsewhere"]).expect("add origin");
        let store = parent.join("store");
        run_store_git(parent, &["init", "--quiet", "store"]).expect("init the store");

        let none = read_store_origin(&store).expect("Git runs");
        run_store_git(&store, &["remote", "add", "origin", "/remote"]).expect("add origin");
        let some = read_store_origin(&store).expect("Git runs");

        assert_eq!(none, None);
        assert_eq!(some.as_deref(), Some("/remote"));
    }

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

        let passed = start_editor(std::ffi::OsStr::new("true"), &[], &path);
        let failed = start_editor(std::ffi::OsStr::new("false"), &[], &path);
        let missing = start_editor(std::ffi::OsStr::new("tikk-test-no-such-editor"), &[], &path);

        assert!(passed.is_ok(), "{passed:?}");
        assert!(
            matches!(&failed, Err(StoreError::EditorFailed { message }) if message.contains("exit status: 1")),
            "{failed:?}"
        );
        assert!(
            matches!(&missing, Err(StoreError::EditorFailed { message }) if message.starts_with("could not start tikk-test-no-such-editor")),
            "{missing:?}"
        );
    }
}
