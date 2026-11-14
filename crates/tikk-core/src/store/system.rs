use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::process::Command;
use std::time::SystemTime;

use crate::fact::Timestamp;
use crate::store::StoreError;

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

    use super::{fill_random, read_host_name, read_host_name_with, start_editor};
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
    fn a_uname_that_exits_nonzero_gives_host_name_unavailable() {
        let error = read_host_name_with("false").expect_err("the program fails");

        assert!(
            matches!(error, StoreError::HostNameUnavailable { .. }),
            "{error:?}"
        );
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
