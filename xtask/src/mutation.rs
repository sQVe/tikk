//! `cargo xtask mutation`: runs cargo-mutants and prints Tau's mutation report on stdout.
//!
//! Exit codes follow Tau's contract: 0 for `pass`, `nothing`, or survivors in audit mode, 2 for
//! survivors in changed mode, and 1 for an error or any unmutated file. Everything except the
//! report goes to stderr, because Tau parses stdout as JSON.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

use anyhow::Context as _;
use serde_json::{Value, json};
use thiserror::Error;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Changed,
    Audit,
}

#[derive(Debug, PartialEq, Eq)]
struct Request {
    mode: Mode,
    targets: Vec<String>,
    max_mutants: Option<usize>,
}

struct Scope {
    diff: Option<PathBuf>,
    files: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct Survivor {
    file: String,
    line: usize,
    mutator: String,
    original: String,
    replacement: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Position {
    line: usize,
    column: usize,
}

enum Outcome {
    Nothing,
    Ran {
        survivors: Vec<Survivor>,
        unmutated: Vec<String>,
    },
}

#[derive(Debug, Error, PartialEq, Eq)]
enum RequestError {
    #[error("Changed mode needs exactly one base commit.")]
    ChangedTargets,
    #[error("Audit mode needs at least one file.")]
    AuditTargets,
    #[error("Unknown mode {mode}. Use changed or audit.")]
    UnknownMode { mode: String },
}

#[derive(Debug, Error, PartialEq, Eq)]
enum MutantsError {
    #[error("The unmutated tree fails to build or pass its tests.")]
    BaselineFailed,
    #[error("cargo mutants failed with {status}.")]
    CommandFailed { status: std::process::ExitStatus },
}

const OUTPUT_DIRECTORY: &str = "target/mutants";
const MAX_JOBS: usize = 4;

fn parse_max_mutants(value: Option<&str>) -> anyhow::Result<usize> {
    let value = value.ok_or_else(|| anyhow::anyhow!("--max-mutants needs a number."))?;

    let parsed: usize = value
        .parse()
        .map_err(|_| anyhow::anyhow!("--max-mutants needs a positive integer, not {value}."))?;

    if parsed == 0 {
        anyhow::bail!("--max-mutants must be at least 1.");
    }

    Ok(parsed)
}

fn parse_request(arguments: &[String]) -> anyhow::Result<Request> {
    let (mode_name, rest) = arguments
        .split_first()
        .ok_or_else(|| anyhow::anyhow!("Name a mode: changed or audit."))?;

    let mut targets = Vec::new();
    let mut max_mutants = None;
    let mut remaining = rest.iter();

    while let Some(argument) = remaining.next() {
        if argument == "--max-mutants" {
            max_mutants = Some(parse_max_mutants(remaining.next().map(String::as_str))?);
        } else if argument.starts_with('-') {
            anyhow::bail!("Unknown option {argument}.");
        } else {
            targets.push(argument.clone());
        }
    }

    let mode = match mode_name.as_str() {
        "changed" if targets.len() == 1 => Mode::Changed,
        "changed" => return Err(RequestError::ChangedTargets.into()),
        "audit" if !targets.is_empty() => Mode::Audit,
        "audit" => return Err(RequestError::AuditTargets.into()),
        _ => {
            return Err(RequestError::UnknownMode {
                mode: mode_name.clone(),
            }
            .into());
        }
    };

    Ok(Request {
        mode,
        targets,
        max_mutants,
    })
}

impl Scope {
    fn arguments(&self) -> Vec<String> {
        let mut arguments = Vec::new();

        if let Some(diff) = &self.diff {
            arguments.push("--in-diff".to_string());
            arguments.push(diff.display().to_string());
        }

        for file in &self.files {
            arguments.push("--file".to_string());
            arguments.push(file.clone());
        }

        arguments
    }
}

// cargo-mutants matches `--file` as a glob against workspace-relative paths, so `./a.rs` or an
// absolute path would match nothing and wrongly report `nothing`.
fn workspace_relative_path(root: &Path, path: &str) -> anyhow::Result<String> {
    let file = root
        .join(path)
        .canonicalize()
        .with_context(|| format!("Could not find {path}"))?;

    let canonical_root = root
        .canonicalize()
        .with_context(|| format!("Could not resolve {}", root.display()))?;

    let relative = file
        .strip_prefix(&canonical_root)
        .map_err(|_| anyhow::anyhow!("{path} is outside the workspace."))?;

    let parts: Vec<String> = relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect();

    Ok(parts.join("/"))
}

fn write_diff(
    git: &str,
    root: &Path,
    output: &Path,
    base: &str,
) -> anyhow::Result<Option<PathBuf>> {
    let diff = Command::new(git)
        .args(["diff", "--no-ext-diff", base, "--"])
        .current_dir(root)
        .stderr(Stdio::inherit())
        .output()
        .context("Could not start git diff")?;

    if !diff.status.success() {
        anyhow::bail!("git diff {base} failed with {}.", diff.status);
    }

    if diff.stdout.is_empty() {
        return Ok(None);
    }

    let path = output.join("changes.diff");

    fs::write(&path, &diff.stdout)
        .with_context(|| format!("Could not write {}", path.display()))?;

    Ok(Some(path))
}

fn count_mutants(
    cargo: &str,
    root: &Path,
    scope: &Scope,
) -> anyhow::Result<BTreeMap<String, usize>> {
    let listing = Command::new(cargo)
        .args(["mutants", "--workspace", "--list", "--json"])
        .args(scope.arguments())
        .current_dir(root)
        .stderr(Stdio::inherit())
        .output()
        .context("Could not start cargo mutants")?;

    if !listing.status.success() {
        anyhow::bail!("cargo mutants --list failed with {}.", listing.status);
    }

    parse_mutant_counts(&listing.stdout)
}

fn parse_mutant_counts(stdout: &[u8]) -> anyhow::Result<BTreeMap<String, usize>> {
    // cargo-mutants prints nothing, not `[]`, when a diff changes no Rust source.
    if stdout.trim_ascii().is_empty() {
        return Ok(BTreeMap::new());
    }

    let mutants: Value =
        serde_json::from_slice(stdout).context("cargo mutants --list printed invalid JSON")?;

    let mutants = mutants
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("cargo mutants --list did not print a JSON array."))?;

    let mut counts = BTreeMap::new();

    for mutant in mutants {
        let file = mutant["file"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("A listed mutant has no file."))?;

        *counts.entry(file.to_string()).or_insert(0) += 1;
    }

    Ok(counts)
}

fn apply_cap(
    counts: &BTreeMap<String, usize>,
    max_mutants: Option<usize>,
) -> (Vec<String>, Vec<String>) {
    let mut remaining = max_mutants.unwrap_or(usize::MAX);
    let mut selected = Vec::new();
    let mut unmutated = Vec::new();

    for (file, &count) in counts {
        if count <= remaining {
            remaining -= count;
            selected.push(file.clone());
        } else {
            unmutated.push(file.clone());
        }
    }

    (selected, unmutated)
}

fn job_count() -> usize {
    let available = std::thread::available_parallelism().map_or(1, |count| count.get());

    available.min(MAX_JOBS)
}

fn run_mutants(cargo: &str, root: &Path, output: &Path, scope: &Scope) -> anyhow::Result<()> {
    let status = Command::new(cargo)
        .args(["mutants", "--workspace", "--no-shuffle", "--jobs"])
        .arg(job_count().to_string())
        .arg("--output")
        .arg(output)
        .args(scope.arguments())
        .current_dir(root)
        .stdout(std::io::stderr())
        .status()
        .context("Could not start cargo mutants")?;

    // cargo-mutants exits 2 for missed mutants and 3 for timeouts. A timed-out mutant counts as
    // caught, as Stryker counts it in Tau's own mutation script, so only missed mutants survive.
    match status.code() {
        Some(0 | 2 | 3) => Ok(()),
        Some(4) => Err(MutantsError::BaselineFailed.into()),
        _ => Err(MutantsError::CommandFailed { status }.into()),
    }
}

fn read_position(value: &Value) -> Option<Position> {
    let line = usize::try_from(value["line"].as_u64()?).ok()?;
    let column = usize::try_from(value["column"].as_u64()?).ok()?;

    Some(Position { line, column })
}

fn span_text(source: &str, start: Position, end: Position) -> String {
    let lines: Vec<&str> = source.lines().collect();
    let mut text = String::new();

    for line_number in start.line..=end.line {
        let Some(line) = lines.get(line_number.saturating_sub(1)) else {
            break;
        };

        let characters: Vec<char> = line.chars().collect();
        let last = characters.len();
        let from = if line_number == start.line {
            start.column.saturating_sub(1)
        } else {
            0
        };
        let to = if line_number == end.line {
            end.column.saturating_sub(1)
        } else {
            last
        };
        let to = to.min(last);

        if line_number > start.line {
            text.push('\n');
        }

        text.extend(&characters[from.min(to)..to]);
    }

    text
}

fn read_survivor(root: &Path, mutant: &Value) -> anyhow::Result<Survivor> {
    let file = mutant["file"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("A missed mutant has no file."))?;
    let start = read_position(&mutant["span"]["start"])
        .ok_or_else(|| anyhow::anyhow!("A missed mutant has no start."))?;
    let end = read_position(&mutant["span"]["end"])
        .ok_or_else(|| anyhow::anyhow!("A missed mutant has no end."))?;

    let source =
        fs::read_to_string(root.join(file)).with_context(|| format!("Could not read {file}"))?;

    Ok(Survivor {
        file: file.to_string(),
        line: start.line,
        mutator: mutant["genre"].as_str().unwrap_or("Unknown").to_string(),
        original: span_text(&source, start, end),
        replacement: mutant["replacement"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    })
}

fn read_survivors(root: &Path, output: &Path) -> anyhow::Result<Vec<Survivor>> {
    let path = output.join("mutants.out").join("outcomes.json");

    let text =
        fs::read_to_string(&path).with_context(|| format!("Could not read {}", path.display()))?;

    let outcomes: Value = serde_json::from_str(&text)
        .with_context(|| format!("{} is not valid JSON", path.display()))?;

    let outcomes = outcomes["outcomes"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("outcomes.json has no outcomes list."))?;

    outcomes
        .iter()
        .filter(|outcome| outcome["summary"] == "MissedMutant")
        .map(|outcome| read_survivor(root, &outcome["scenario"]["Mutant"]))
        .collect()
}

fn mutate(root: &Path, request: &Request, cargo: &str, git: &str) -> anyhow::Result<Outcome> {
    let output = root.join(OUTPUT_DIRECTORY);

    fs::create_dir_all(&output)
        .with_context(|| format!("Could not create {}", output.display()))?;

    let scope = match request.mode {
        Mode::Changed => match write_diff(git, root, &output, &request.targets[0])? {
            Some(diff) => Scope {
                diff: Some(diff),
                files: Vec::new(),
            },
            None => return Ok(Outcome::Nothing),
        },
        Mode::Audit => Scope {
            diff: None,
            files: request
                .targets
                .iter()
                .map(|path| workspace_relative_path(root, path))
                .collect::<anyhow::Result<Vec<_>>>()?,
        },
    };

    let counts = count_mutants(cargo, root, &scope)?;

    if counts.is_empty() {
        return Ok(Outcome::Nothing);
    }

    let (selected, unmutated) = apply_cap(&counts, request.max_mutants);

    if selected.is_empty() {
        return Ok(Outcome::Ran {
            survivors: Vec::new(),
            unmutated,
        });
    }

    let selected_scope = Scope {
        diff: scope.diff,
        files: selected,
    };

    run_mutants(cargo, root, &output, &selected_scope)?;

    let survivors = read_survivors(root, &output)?;

    Ok(Outcome::Ran {
        survivors,
        unmutated,
    })
}

fn error_report(message: &str) -> Value {
    json!({
        "version": 1,
        "status": "error",
        "error": message,
        "survivors": [],
        "unmutated": [],
    })
}

fn ran_report(mode: Mode, survivors: &[Survivor], unmutated: &[String]) -> (Value, u8) {
    let survivor_values: Vec<Value> = survivors
        .iter()
        .map(|survivor| {
            json!({
                "file": survivor.file,
                "line": survivor.line,
                "mutator": survivor.mutator,
                "original": survivor.original,
                "replacement": survivor.replacement,
                // cargo-mutants measures no coverage, so every missed mutant counts as covered.
                "covered": true,
            })
        })
        .collect();

    let mut report = json!({
        "version": 1,
        "status": "pass",
        "survivors": survivor_values,
        "unmutated": unmutated,
    });

    if !survivors.is_empty() {
        report["status"] = json!("survivors");
    }

    if !unmutated.is_empty() {
        if survivors.is_empty() {
            report["status"] = json!("error");
            report["error"] = json!("Files over the mutant cap were not mutated.");
        }

        return (report, 1);
    }

    let exit = match (survivors.is_empty(), mode) {
        (false, Mode::Changed) => 2,
        _ => 0,
    };

    (report, exit)
}

fn report(root: &Path, arguments: &[String], cargo: &str, git: &str) -> (Value, u8) {
    let request = match parse_request(arguments) {
        Ok(request) => request,
        Err(error) => return (error_report(&format!("{error:#}")), 1),
    };

    match mutate(root, &request, cargo, git) {
        Ok(Outcome::Nothing) => (
            json!({ "version": 1, "status": "nothing", "survivors": [], "unmutated": [] }),
            0,
        ),
        Ok(Outcome::Ran {
            survivors,
            unmutated,
        }) => ran_report(request.mode, &survivors, &unmutated),
        Err(error) => (error_report(&format!("{error:#}")), 1),
    }
}

#[expect(
    clippy::print_stdout,
    reason = "the mutation report is the command's stdout output"
)]
pub(crate) fn run(root: &Path, arguments: &[String]) -> ExitCode {
    let (report, exit) = report(root, arguments, "cargo", "git");

    println!("{report}");
    ExitCode::from(exit)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use tempfile::TempDir;

    use super::*;

    const LISTING: &str =
        r#"[{"file":"a.rs"},{"file":"a.rs"},{"file":"b.rs"},{"file":"b.rs"},{"file":"c.rs"}]"#;
    const DIFF: &str = "diff --git a/a.rs b/a.rs";

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn survivor() -> Survivor {
        Survivor {
            file: "src/lib.rs".to_string(),
            line: 3,
            mutator: "BinaryOperator".to_string(),
            original: "<=".to_string(),
            replacement: ">".to_string(),
        }
    }

    struct Fixture {
        folder: TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            let folder = crate::test_support::temporary_directory();
            let outcomes = folder.path().join(OUTPUT_DIRECTORY).join("mutants.out");

            for file in ["a.rs", "b.rs", "c.rs"] {
                fs::write(folder.path().join(file), "").expect("write a source file");
            }

            fs::create_dir_all(&outcomes).expect("create the output folder");
            fs::write(outcomes.join("outcomes.json"), r#"{"outcomes":[]}"#)
                .expect("write outcomes");

            Self { folder }
        }

        fn tool(&self, name: &str, script: &str) -> String {
            let path = self.folder.path().join(name);

            fs::write(&path, format!("#!/bin/sh\n{script}\n")).expect("write a fake tool");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                .expect("make the fake tool runnable");

            path.to_str()
                .expect("the fake tool path is UTF-8")
                .to_string()
        }

        fn cargo(&self, listing: &str, list_exit: u8, run: &str) -> String {
            let script = format!(
                "printf '%s\\n' \"$*\" >> \"$(dirname \"$0\")/cargo.log\"\n\
             case \"$*\" in *--list*) printf '%s' '{listing}'; exit {list_exit};; esac\n\
             {run}"
            );

            self.tool("cargo", &script)
        }

        fn git(&self, diff: &str, exit: u8) -> String {
            self.tool("git", &format!("printf '%s' '{diff}'\nexit {exit}"))
        }

        fn cargo_calls(&self) -> Vec<String> {
            let log =
                fs::read_to_string(self.folder.path().join("cargo.log")).expect("read cargo.log");

            log.lines().map(str::to_string).collect()
        }

        fn report(&self, arguments: &[&str], cargo: &str, git: &str) -> (Value, u8) {
            report(self.folder.path(), &strings(arguments), cargo, git)
        }

        fn audit(&self, cargo: &str) -> (Value, u8) {
            let git = self.git("", 0);

            self.report(&["audit", "a.rs"], cargo, &git)
        }
    }

    fn status(report: &(Value, u8)) -> (Option<&str>, u8) {
        (report.0["status"].as_str(), report.1)
    }

    #[test]
    fn run_fails_on_bad_arguments() {
        let fixture = Fixture::new();

        assert_eq!(
            run(fixture.folder.path(), &strings(&["other"])),
            ExitCode::FAILURE
        );
        assert!(!fixture.folder.path().join("cargo.log").exists());
    }

    #[test]
    fn report_fails_when_the_listing_fails() {
        let fixture = Fixture::new();
        let cargo = fixture.cargo("[]", 1, "touch should-not-run");

        assert_eq!(status(&fixture.audit(&cargo)), (Some("error"), 1));
        assert_eq!(fixture.cargo_calls().len(), 1);
        assert!(!fixture.folder.path().join("should-not-run").exists());
    }

    #[test]
    fn report_fails_when_the_listing_is_not_json() {
        for listing in ["not json", "{}", "[{}]"] {
            let fixture = Fixture::new();
            let cargo = fixture.cargo(listing, 0, "touch should-not-run");

            assert_eq!(
                status(&fixture.audit(&cargo)),
                (Some("error"), 1),
                "{listing}"
            );
            assert_eq!(fixture.cargo_calls().len(), 1);
            assert!(!fixture.folder.path().join("should-not-run").exists());
        }
    }

    #[test]
    fn report_reads_the_exit_code_of_the_mutants_run() {
        let cases = [
            ("exit 0", (Some("pass"), 0)),
            ("exit 2", (Some("pass"), 0)),
            ("exit 3", (Some("pass"), 0)),
            ("exit 4", (Some("error"), 1)),
            ("exit 1", (Some("error"), 1)),
            ("kill -9 $$", (Some("error"), 1)),
        ];

        for (run, expected) in cases {
            let fixture = Fixture::new();
            let cargo = fixture.cargo(LISTING, 0, run);

            assert_eq!(status(&fixture.audit(&cargo)), expected, "{run}");
        }
    }

    #[test]
    fn report_fails_when_git_diff_fails() {
        let fixture = Fixture::new();
        let cargo = fixture.cargo(LISTING, 0, "exit 0");
        let git = fixture.git("", 128);

        let report = fixture.report(&["changed", "main"], &cargo, &git);

        assert_eq!(status(&report), (Some("error"), 1));
        assert!(!fixture.folder.path().join("cargo.log").exists());
        assert!(
            !fixture
                .folder
                .path()
                .join(OUTPUT_DIRECTORY)
                .join("changes.diff")
                .exists()
        );
    }

    #[test]
    fn report_finds_nothing_without_work() {
        let fixture = Fixture::new();
        let cargo = fixture.cargo("[]", 0, "touch should-not-run");
        let git = fixture.git("", 0);

        let empty_diff = fixture.report(&["changed", "main"], &cargo, &git);

        assert_eq!(status(&empty_diff), (Some("nothing"), 0));
        assert!(!fixture.folder.path().join("cargo.log").exists());

        let empty_listing = fixture.audit(&cargo);

        assert_eq!(status(&empty_listing), (Some("nothing"), 0));
        assert_eq!(fixture.cargo_calls().len(), 1);
        assert!(!fixture.folder.path().join("should-not-run").exists());
    }

    #[test]
    fn report_finds_nothing_when_the_listing_prints_nothing() {
        for listing in ["", " \n\t"] {
            let fixture = Fixture::new();
            let cargo = fixture.cargo(listing, 0, "exit 0");
            let git = fixture.git(DIFF, 0);

            let report = fixture.report(&["changed", "main"], &cargo, &git);

            assert_eq!(status(&report), (Some("nothing"), 0));
            assert_eq!(fixture.cargo_calls().len(), 1);
        }
    }

    #[test]
    fn report_runs_the_selected_files_within_the_diff() {
        let fixture = Fixture::new();
        let cargo = fixture.cargo(LISTING, 0, "exit 0");
        let git = fixture.git(DIFF, 0);
        let diff = fixture
            .folder
            .path()
            .join(OUTPUT_DIRECTORY)
            .join("changes.diff");

        let report = fixture.report(&["changed", "main", "--max-mutants", "4"], &cargo, &git);
        let calls = fixture.cargo_calls();

        assert_eq!(status(&report), (Some("error"), 1));
        assert_eq!(report.0["unmutated"], json!(["c.rs"]));
        assert_eq!(fs::read_to_string(&diff).expect("read saved diff"), DIFF);
        assert_eq!(calls.len(), 2);
        assert!(
            calls[0].ends_with(&format!("--list --json --in-diff {}", diff.display())),
            "{}",
            calls[0]
        );
        assert!(
            calls[1].ends_with(&format!(
                "--in-diff {} --file a.rs --file b.rs",
                diff.display()
            )),
            "{}",
            calls[1]
        );
    }

    #[test]
    fn report_runs_the_requested_audit_files() {
        let fixture = Fixture::new();
        let cargo = fixture.cargo(r#"[{"file":"a.rs"},{"file":"b.rs"}]"#, 0, "exit 0");
        let git = fixture.git("", 0);

        let report = fixture.report(&["audit", "a.rs", "./b.rs"], &cargo, &git);
        let calls = fixture.cargo_calls();

        assert_eq!(status(&report), (Some("pass"), 0));
        assert_eq!(calls.len(), 2);
        assert!(
            calls[0].ends_with("--list --json --file a.rs --file b.rs"),
            "{}",
            calls[0]
        );
        assert!(
            calls[1].ends_with(" --file a.rs --file b.rs"),
            "{}",
            calls[1]
        );
        assert!(
            calls.iter().all(|call| !call.contains("--in-diff")),
            "{calls:?}"
        );
    }

    #[test]
    fn report_fails_when_a_tool_cannot_start() {
        let missing = "/nonexistent/tikk-missing-program";
        let fixture = Fixture::new();
        let cargo = fixture.cargo(LISTING, 0, "exit 0");
        let git = fixture.git(DIFF, 0);

        let without_git = fixture.report(&["changed", "main"], &cargo, missing);
        let without_cargo = fixture.report(&["audit", "a.rs"], missing, &git);

        assert_eq!(status(&without_git), (Some("error"), 1));
        assert_eq!(status(&without_cargo), (Some("error"), 1));
        assert!(!fixture.folder.path().join("cargo.log").exists());
    }

    #[test]
    fn report_fails_when_cargo_cannot_start_the_run() {
        let fixture = Fixture::new();
        let cargo = fixture.tool(
            "cargo",
            &format!("case \"$*\" in *--list*) printf '%s' '{LISTING}'; rm \"$0\";; esac"),
        );

        assert_eq!(status(&fixture.audit(&cargo)), (Some("error"), 1));
        assert!(!Path::new(&cargo).exists());
    }

    #[test]
    fn scope_arguments_keep_flag_and_value_order() {
        let diff = PathBuf::from("out/changes.diff");
        let cases = [
            (None, vec![], vec![]),
            (
                Some(diff.clone()),
                vec![],
                strings(&["--in-diff", "out/changes.diff"]),
            ),
            (
                None,
                strings(&["a.rs", "b.rs"]),
                strings(&["--file", "a.rs", "--file", "b.rs"]),
            ),
            (
                Some(diff),
                strings(&["a.rs", "b.rs"]),
                strings(&[
                    "--in-diff",
                    "out/changes.diff",
                    "--file",
                    "a.rs",
                    "--file",
                    "b.rs",
                ]),
            ),
        ];

        for (diff, files, expected) in cases {
            let scope = Scope { diff, files };

            assert_eq!(scope.arguments(), expected, "{expected:?}");
        }
    }

    #[test]
    fn error_report_carries_the_message() {
        assert_eq!(
            error_report("broken"),
            json!({
                "version": 1, "status": "error", "error": "broken", "survivors": [], "unmutated": [],
            })
        );
    }

    #[test]
    fn job_count_uses_available_cores_up_to_the_limit() {
        let available = std::thread::available_parallelism().map_or(1, |count| count.get());
        let jobs = job_count();

        assert!((1..=MAX_JOBS).contains(&jobs), "{jobs}");
        assert_eq!(jobs, available.min(MAX_JOBS));
    }

    #[test]
    fn parse_request_reads_modes_and_cap() {
        let changed = parse_request(&strings(&["changed", "main", "--max-mutants", "5"]))
            .expect("changed parses");
        let audit = parse_request(&strings(&["audit", "a.rs", "b.rs"])).expect("audit parses");

        assert_eq!(
            changed,
            Request {
                mode: Mode::Changed,
                targets: strings(&["main"]),
                max_mutants: Some(5),
            }
        );
        assert_eq!(
            audit,
            Request {
                mode: Mode::Audit,
                targets: strings(&["a.rs", "b.rs"]),
                max_mutants: None,
            }
        );
    }

    #[test]
    fn parse_request_distinguishes_invalid_targets_from_unknown_modes() {
        let cases = [
            (strings(&["changed"]), RequestError::ChangedTargets),
            (
                strings(&["changed", "a", "b"]),
                RequestError::ChangedTargets,
            ),
            (strings(&["audit"]), RequestError::AuditTargets),
            (
                strings(&["other", "a.rs"]),
                RequestError::UnknownMode {
                    mode: "other".to_string(),
                },
            ),
        ];

        for (arguments, expected) in cases {
            let error = parse_request(&arguments).expect_err("invalid request fails");

            assert_eq!(
                error.downcast_ref::<RequestError>(),
                Some(&expected),
                "{arguments:?}"
            );
        }
    }

    #[test]
    fn run_mutants_distinguishes_a_failing_baseline_from_tool_failure() {
        for code in [1, 4] {
            let fixture = Fixture::new();
            let cargo = fixture.tool("cargo", &format!("exit {code}"));
            let scope = Scope {
                diff: None,
                files: strings(&["a.rs"]),
            };
            let output = fixture.folder.path().join(OUTPUT_DIRECTORY);

            let error = run_mutants(&cargo, fixture.folder.path(), &output, &scope)
                .expect_err("failed mutants run is an error");
            let typed = error.downcast_ref::<MutantsError>();

            if code == 4 {
                assert_eq!(typed, Some(&MutantsError::BaselineFailed));
            } else {
                assert!(
                    matches!(typed, Some(MutantsError::CommandFailed { status }) if status.code() == Some(code))
                );
            }
        }
    }

    #[test]
    fn parse_request_rejects_bad_input() {
        let cases: &[&[&str]] = &[
            &[],
            &["changed"],
            &["changed", "a", "b"],
            &["audit"],
            &["audit", "a.rs", "--max-mutants", "0"],
            &["audit", "a.rs", "--max-mutants"],
            &["audit", "a.rs", "--max-mutants", "no"],
            &["audit", "a.rs", "--jobs"],
            &["other", "a.rs"],
        ];

        for arguments in cases {
            let fixture = Fixture::new();
            let cargo = fixture.cargo(LISTING, 0, "exit 0");
            let git = fixture.git(DIFF, 0);
            let report = fixture.report(arguments, &cargo, &git);

            assert_eq!(status(&report), (Some("error"), 1), "{arguments:?}");
            assert!(!fixture.folder.path().join("cargo.log").exists());
            assert!(
                !fixture
                    .folder
                    .path()
                    .join(OUTPUT_DIRECTORY)
                    .join("changes.diff")
                    .exists()
            );
        }
    }

    #[test]
    fn apply_cap_skips_files_that_do_not_fit() {
        let counts = BTreeMap::from([
            ("a.rs".to_string(), 2),
            ("b.rs".to_string(), 5),
            ("c.rs".to_string(), 1),
        ]);

        assert_eq!(
            apply_cap(&counts, Some(3)),
            (strings(&["a.rs", "c.rs"]), strings(&["b.rs"]))
        );
        assert_eq!(
            apply_cap(&counts, None),
            (strings(&["a.rs", "b.rs", "c.rs"]), vec![])
        );
    }

    #[test]
    fn workspace_relative_path_normalizes_existing_files() {
        let root = crate::test_support::temporary_directory();
        let absolute = root.path().join("a.rs");

        fs::write(&absolute, "").expect("write source file");

        assert_eq!(
            workspace_relative_path(root.path(), "./a.rs").expect("relative"),
            "a.rs"
        );
        assert_eq!(
            workspace_relative_path(root.path(), &absolute.display().to_string())
                .expect("absolute"),
            "a.rs"
        );
    }

    #[test]
    fn report_rejects_missing_or_outside_files_before_running_tools() {
        let fixture = Fixture::new();
        let outside = crate::test_support::temporary_directory();
        let file = outside.path().join("outside.rs");

        fs::write(&file, "").expect("write outside file");

        for path in ["missing.rs", file.to_str().expect("UTF-8 path")] {
            let cargo = fixture.cargo(LISTING, 0, "exit 0");
            let git = fixture.git("", 0);
            let report = fixture.report(&["audit", path], &cargo, &git);

            assert_eq!(status(&report), (Some("error"), 1));
            assert!(!fixture.folder.path().join("cargo.log").exists());
        }
    }

    #[test]
    fn empty_listing_counts_no_mutants() {
        assert_eq!(
            parse_mutant_counts(b"").expect("empty listing"),
            BTreeMap::new()
        );
        assert_eq!(
            parse_mutant_counts(b" \n\t").expect("whitespace listing"),
            BTreeMap::new()
        );
    }

    #[test]
    fn non_empty_invalid_listing_is_an_error() {
        let error = parse_mutant_counts(b"not json").expect_err("invalid JSON fails");

        assert!(error.downcast_ref::<serde_json::Error>().is_some());
    }

    #[test]
    fn read_survivors_keeps_only_missed_mutants() {
        let root = crate::test_support::temporary_directory();
        let output = root.path().join("out");
        let mutant = |summary: &str, replacement: &str| {
            json!({
                "summary": summary,
                "scenario": { "Mutant": {
                    "file": "lib.rs", "genre": "BinaryOperator", "replacement": replacement,
                    "span": { "start": { "line": 1, "column": 3 }, "end": { "line": 1, "column": 5 } },
                } },
            })
        };
        let outcomes = json!({ "outcomes": [
        { "scenario": "Baseline", "summary": "Success" },
        mutant("CaughtMutant", "||"), mutant("MissedMutant", ">"), mutant("Timeout", "<"),
    ] });

        fs::create_dir_all(output.join("mutants.out")).expect("create output");
        fs::write(root.path().join("lib.rs"), "a <= b\n").expect("write source");
        fs::write(
            output.join("mutants.out/outcomes.json"),
            outcomes.to_string(),
        )
        .expect("write outcomes");

        let survivors = read_survivors(root.path(), &output).expect("survivors parse");

        assert_eq!(
            survivors,
            vec![Survivor {
                file: "lib.rs".to_string(),
                line: 1,
                mutator: "BinaryOperator".to_string(),
                original: "<=".to_string(),
                replacement: ">".to_string(),
            }]
        );
    }

    #[test]
    fn span_text_reads_single_and_multiple_lines() {
        let source = "fn a() {\n    x <= y\n}\n";
        let start = Position { line: 2, column: 7 };

        assert_eq!(
            span_text(source, start, Position { line: 2, column: 9 }),
            "<="
        );
        assert_eq!(
            span_text(
                source,
                Position { line: 1, column: 8 },
                Position { line: 3, column: 2 }
            ),
            "{\n    x <= y\n}"
        );
    }

    #[test]
    fn ran_report_sets_status_and_exit_code() {
        let found = [survivor()];
        let skipped = strings(&["b.rs"]);

        let (passed, passed_exit) = ran_report(Mode::Changed, &[], &[]);
        let (changed, changed_exit) = ran_report(Mode::Changed, &found, &[]);
        let (audit, audit_exit) = ran_report(Mode::Audit, &found, &[]);
        let (capped, capped_exit) = ran_report(Mode::Audit, &[], &skipped);
        let (both, both_exit) = ran_report(Mode::Changed, &found, &skipped);

        assert_eq!((passed["status"].as_str(), passed_exit), (Some("pass"), 0));
        assert_eq!(
            (changed["status"].as_str(), changed_exit),
            (Some("survivors"), 2)
        );
        assert_eq!(
            (audit["status"].as_str(), audit_exit),
            (Some("survivors"), 0)
        );
        assert_eq!((capped["status"].as_str(), capped_exit), (Some("error"), 1));
        assert_eq!((both["status"].as_str(), both_exit), (Some("survivors"), 1));
        assert_eq!(
            changed["survivors"][0],
            json!({
                "file": "src/lib.rs", "line": 3, "mutator": "BinaryOperator", "original": "<=",
                "replacement": ">", "covered": true,
            })
        );
        assert_eq!(capped["unmutated"], json!(["b.rs"]));
    }
}
