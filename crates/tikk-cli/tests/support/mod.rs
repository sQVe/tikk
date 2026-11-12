#![allow(
    dead_code,
    reason = "each test file uses a different part of the shared helper"
)]

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;
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
        std::fs::create_dir(directory.path().join("work")).expect("create a working directory");

        Self { directory }
    }

    pub(crate) fn initialized() -> Self {
        let home = Self::new();
        let run = home.tikk(&["init", "--machine", "test"]);

        assert_eq!(run.exit_code, 0, "init: {}", run.stderr);

        home
    }

    pub(crate) fn store(&self) -> PathBuf {
        self.directory.path().join("store")
    }

    pub(crate) fn work(&self) -> PathBuf {
        self.directory.path().join("work")
    }

    pub(crate) fn tikk(&self, arguments: &[&str]) -> Run {
        self.tikk_in(&self.work(), arguments)
    }

    pub(crate) fn tikk_in(&self, directory: &Path, arguments: &[&str]) -> Run {
        let mut command = Command::new(env!("CARGO_BIN_EXE_tikk"));

        command
            .args(arguments)
            .current_dir(directory)
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

    pub(crate) fn new_ticket(&self, arguments: &[&str]) -> String {
        let mut all = vec!["new", "--json"];

        all.extend_from_slice(arguments);

        let run = self.tikk(&all);

        assert_eq!(run.exit_code, 0, "new {arguments:?}: {}", run.stderr);

        parse_json(&run.stdout)["id"]
            .as_str()
            .expect("new prints the ID")
            .to_owned()
    }

    pub(crate) fn document(&self, name: &str, text: &str) -> PathBuf {
        let path = self.work().join(name);

        std::fs::write(&path, text).expect("write a ticket document");

        path
    }

    pub(crate) fn ticket_files(&self) -> Vec<PathBuf> {
        let mut files = Vec::new();
        let Ok(projects) = std::fs::read_dir(self.store().join("tickets")) else {
            return files;
        };

        for project in projects {
            let project = project.expect("read a project folder").path();

            for entry in std::fs::read_dir(&project).expect("list a project folder") {
                let path = entry.expect("read a ticket entry").path();

                if path.extension().is_some_and(|extension| extension == "md") {
                    files.push(path);
                }
            }
        }

        files.sort();

        files
    }

    pub(crate) fn git(&self, arguments: &[&str]) -> String {
        run_git(&self.store(), arguments)
    }
}

pub(crate) fn parse_json(text: &str) -> Value {
    serde_json::from_str(text).expect("tikk prints one JSON value")
}

pub(crate) fn run_git(directory: &Path, arguments: &[&str]) -> String {
    let mut command = Command::new("git");

    command.arg("-C").arg(directory).args(arguments);

    for name in REPOSITORY_ENVIRONMENT {
        command.env_remove(name);
    }

    let output = command.output().expect("start git");

    assert!(output.status.success(), "git {arguments:?} failed");

    String::from_utf8(output.stdout).expect("git prints UTF-8")
}
