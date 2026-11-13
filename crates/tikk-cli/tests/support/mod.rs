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

const IDENTITY_ENVIRONMENT: &[&str] = &["TIKK_AGENT", "TIKK_SESSION", "TIKK_SESSION_LOG"];

/// The `EILSEQ` code on macOS, where APFS refuses a file name that is not UTF-8.
const ILLEGAL_BYTE_SEQUENCE: i32 = 92;

/// Creates the folder and returns true, or returns false when the file system refuses the name
/// because it is not UTF-8. Any other error fails the test.
#[expect(
    clippy::print_stderr,
    reason = "a test that returns early names the reason in its output"
)]
pub(crate) fn create_folder_unless_name_refused(path: &Path) -> bool {
    let Err(error) = std::fs::create_dir(path) else {
        return true;
    };

    if error.raw_os_error() == Some(ILLEGAL_BYTE_SEQUENCE) {
        eprintln!("skipped: the file system refuses the name {path:?}: {error}");

        return false;
    }

    panic!("create {path:?}: {error}");
}

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

    pub(crate) fn on_remote(remote: &Remote, machine: &str) -> Self {
        let home = Self::new();
        let run = home.tikk(&["init", "--remote", &remote.url(), "--machine", machine]);

        assert_eq!(run.exit_code, 0, "init --remote: {}", run.stderr);

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
        self.tikk_with_environment(directory, &[], arguments)
    }

    pub(crate) fn tikk_with_environment(
        &self,
        directory: &Path,
        environment: &[(&str, &Path)],
        arguments: &[&str],
    ) -> Run {
        let mut command = self.command(arguments);

        command
            .current_dir(directory)
            .envs(environment.iter().copied());

        finish(command.output().expect("start the tikk binary"))
    }

    pub(crate) fn command(&self, arguments: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_tikk"));

        command
            .args(arguments)
            .current_dir(self.work())
            .env("TIKK_HOME", self.store())
            .env("HOME", self.directory.path().join("home"))
            .env_remove("EDITOR");

        for name in REPOSITORY_ENVIRONMENT.iter().chain(IDENTITY_ENVIRONMENT) {
            command.env_remove(name);
        }

        command
    }

    pub(crate) fn tikk_as(&self, agent: &str, arguments: &[&str]) -> Run {
        let mut command = self.command(arguments);

        command.env("TIKK_AGENT", agent);

        finish(command.output().expect("start the tikk binary"))
    }

    pub(crate) fn plan_and_slice(&self) -> (String, String) {
        let plan = self.new_ticket(&["plan", "Move to tikk"]);
        let slice = self.slice_under(&plan, "Add the store", &[]);

        (plan, slice)
    }

    pub(crate) fn slice_under(&self, plan: &str, title: &str, blocked_by: &[&str]) -> String {
        let document = self.document(
            "slice.md",
            &format!(
                "---\nkind: slice\ntitle: {title}\nstatus: open\nparent: {plan}\nblockedBy: [{}]\ncriteria:\n  - id: s1\n    check: cargo nextest run\n    expected: The tests pass.\n---\n",
                blocked_by.join(", ")
            ),
        );

        self.new_ticket(&["--file", document.to_str().expect("a UTF-8 path")])
    }

    pub(crate) fn fact_lines(&self) -> Vec<Value> {
        let mut files = Vec::new();
        let Ok(machines) = std::fs::read_dir(self.store().join("facts")) else {
            return Vec::new();
        };

        for machine in machines {
            let machine = machine.expect("read a machine folder").path();

            for entry in std::fs::read_dir(&machine).expect("list a machine folder") {
                files.push(entry.expect("read a fact file entry").path());
            }
        }

        files.sort();

        files
            .iter()
            .flat_map(|path| {
                std::fs::read_to_string(path)
                    .expect("read a fact file")
                    .lines()
                    .map(parse_json)
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    pub(crate) fn append_fact_line(&self, file: &str, line: &str) {
        self.append_machine_fact_line("test", file, line);
    }

    pub(crate) fn append_machine_fact_line(&self, machine: &str, file: &str, line: &str) {
        use std::io::Write as _;

        let folder = self.store().join("facts").join(machine);
        std::fs::create_dir_all(&folder).expect("create the machine folder");
        let mut opened = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(folder.join(file))
            .expect("open the fact file");

        writeln!(opened, "{line}").expect("append the fact line");
    }

    pub(crate) fn sync_json(&self) -> Value {
        let run = self.tikk(&["sync", "--json"]);

        assert_eq!(run.exit_code, 0, "sync: {}", run.stderr);

        parse_json(&run.stdout)
    }

    pub(crate) fn listed_ids(&self) -> Vec<String> {
        let run = self.tikk(&["ls", "--json"]);

        assert_eq!(run.exit_code, 0, "ls: {}", run.stderr);

        let mut ids: Vec<String> = parse_json(&run.stdout)["tickets"]
            .as_array()
            .expect("ls lists tickets")
            .iter()
            .map(|ticket| ticket["id"].as_str().expect("a row has an ID").to_owned())
            .collect();

        ids.sort();

        ids
    }

    pub(crate) fn show_json(&self, id: &str) -> Value {
        let run = self.tikk(&["show", id, "--json"]);

        assert_eq!(run.exit_code, 0, "show {id}: {}", run.stderr);

        parse_json(&run.stdout)
    }

    pub(crate) fn share_id(&self, id: &str) -> Vec<String> {
        let first = PathBuf::from(
            self.show_json(id)["path"]
                .as_str()
                .expect("show prints the path"),
        );
        let second = first.with_file_name(format!("{id}-copy.md"));

        std::fs::copy(&first, &second).expect("put a second file with the ID");

        let mut paths: Vec<String> = [first, second]
            .iter()
            .map(|path| path.to_str().expect("a UTF-8 path").to_owned())
            .collect();

        paths.sort();

        paths
    }

    pub(crate) fn lock_file(&self) -> std::fs::File {
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.store().join(".git/tikk.lock"))
            .expect("open the store lock file")
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

    pub(crate) fn settle_files(&self) {
        settle_folder(&self.store());
    }

    pub(crate) fn store_files(&self) -> Vec<(PathBuf, Vec<u8>)> {
        let mut files = Vec::new();

        collect_files(&self.store(), &self.store(), &mut files);
        files.sort();

        files
    }
}

fn settle_folder(folder: &Path) {
    let past = std::time::SystemTime::now() - std::time::Duration::from_secs(60);

    for entry in std::fs::read_dir(folder).expect("list a store folder") {
        let path = entry.expect("read a store entry").path();

        if path.ends_with(".git") {
            continue;
        }

        if path.is_dir() {
            settle_folder(&path);
            continue;
        }

        std::fs::File::options()
            .write(true)
            .open(&path)
            .and_then(|file| file.set_modified(past))
            .expect("move the change time back");
    }
}

fn collect_files(root: &Path, folder: &Path, files: &mut Vec<(PathBuf, Vec<u8>)>) {
    for entry in std::fs::read_dir(folder).expect("list a store folder") {
        let path = entry.expect("read a store entry").path();

        if path.ends_with(".git") {
            continue;
        }

        if path.is_dir() {
            collect_files(root, &path, files);
            continue;
        }

        let relative = path
            .strip_prefix(root)
            .expect("inside the store")
            .to_owned();

        files.push((relative, std::fs::read(&path).expect("read a store file")));
    }
}

pub(crate) struct Remote {
    directory: TempDir,
}

impl Remote {
    pub(crate) fn new() -> Self {
        let directory = Builder::new()
            .prefix("tikk-cli-remote-")
            .tempdir()
            .expect("create a temporary directory");

        run_git(
            directory.path(),
            &["init", "--quiet", "--bare", "--initial-branch=main"],
        );

        Self { directory }
    }

    pub(crate) fn path(&self) -> &Path {
        self.directory.path()
    }

    pub(crate) fn url(&self) -> String {
        self.path().to_str().expect("a UTF-8 path").to_owned()
    }

    pub(crate) fn git(&self, arguments: &[&str]) -> String {
        run_git(self.path(), arguments)
    }
}

pub(crate) fn finish(output: std::process::Output) -> Run {
    Run {
        exit_code: output.status.code().expect("tikk exits with a code"),
        stdout: String::from_utf8(output.stdout).expect("tikk prints UTF-8"),
        stderr: String::from_utf8(output.stderr).expect("tikk prints UTF-8"),
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
