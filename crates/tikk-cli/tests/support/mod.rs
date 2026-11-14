use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::{Builder, TempDir};

/// Git reads these before `-C`, so a test started from a Git hook would reach the tikk repository.
const REPOSITORY_ENVIRONMENT: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_COMMON_DIR",
];

pub(crate) struct Run {
    pub(crate) exit_code: i32,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

pub(crate) struct Home {
    directory: TempDir,
}

impl Home {
    pub(crate) fn new() -> Self {
        let directory = Builder::new()
            .prefix("tikk-cli-test-")
            .tempdir()
            .expect("create a temporary directory");

        std::fs::create_dir(directory.path().join("store")).expect("create an empty store folder");

        Self { directory }
    }

    pub(crate) fn store(&self) -> PathBuf {
        self.directory.path().join("store")
    }

    pub(crate) fn tikk(&self, arguments: &[&str]) -> Run {
        let mut command = Command::new(env!("CARGO_BIN_EXE_tikk"));

        command
            .args(arguments)
            .env("TIKK_HOME", self.store())
            .env("HOME", self.directory.path().join("home"));

        for name in REPOSITORY_ENVIRONMENT {
            command.env_remove(name);
        }

        let output = command.output().expect("start the tikk binary");

        Run {
            exit_code: output.status.code().expect("tikk exits with a code"),
            stdout: String::from_utf8(output.stdout).expect("tikk prints UTF-8"),
            stderr: String::from_utf8(output.stderr).expect("tikk prints UTF-8"),
        }
    }

    #[allow(
        dead_code,
        reason = "only some test files inspect the store's Git history"
    )]
    pub(crate) fn git(&self, arguments: &[&str]) -> String {
        run_git(&self.store(), arguments)
    }
}

fn run_git(directory: &Path, arguments: &[&str]) -> String {
    let mut command = Command::new("git");

    command.arg("-C").arg(directory).args(arguments);

    for name in REPOSITORY_ENVIRONMENT {
        command.env_remove(name);
    }

    let output = command.output().expect("start git");

    assert!(output.status.success(), "git {arguments:?} failed");

    String::from_utf8(output.stdout).expect("git prints UTF-8")
}
