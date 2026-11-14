use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt as _;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::store::StoreError;
use crate::store::sync::{FileEntry, FileKind, PendingFile, PendingReason, SyncEffects};
use crate::store::ticket_files::{TICKETS_FOLDER, io_error, parse_ticket};
use crate::ticket::ProjectName;

const SETTLE_TIME: Duration = Duration::from_secs(2);
const FACTS_FOLDER: &str = "facts";
pub(crate) const MERGE_HEAD: &str = ".git/MERGE_HEAD";

#[derive(Debug, Default)]
pub(crate) struct SyncPlan {
    /// The `main` of `origin` from the fetch, pinned so a later fetch cannot change the merge.
    pub(crate) fetched: Option<String>,
    pub(crate) stage: Vec<StagedFile>,
    pub(crate) remove: Vec<String>,
    pub(crate) pending: Vec<PendingFile>,
}

impl SyncPlan {
    pub(crate) fn committed_paths(&self) -> Vec<String> {
        let mut paths: Vec<String> = self
            .stage
            .iter()
            .map(|file| file.path.clone())
            .chain(self.remove.iter().cloned())
            .collect();

        paths.sort();

        paths
    }
}

#[derive(Debug)]
pub(crate) struct StagedFile {
    pub(crate) path: String,
    pub(crate) kind: FileKind,
    pub(crate) bytes: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
enum Change {
    Added(String),
    Modified(String),
    Deleted(String),
    NameNotUtf8(String),
}

pub(crate) fn settle_deadline(
    root: &Path,
    effects: &SyncEffects,
) -> Result<Option<SystemTime>, StoreError> {
    let mut latest = None;

    for change in read_changes(root, effects.run_git)? {
        let (Change::Added(path) | Change::Modified(path)) = change else {
            continue;
        };

        if is_fact(&path) {
            continue;
        }

        if let Some(entry) = (effects.read_entry)(&root.join(&path))? {
            latest = latest.max(Some(entry.modified));
        }
    }

    Ok(latest.map(|modified| modified + SETTLE_TIME))
}

pub(crate) fn read_plan(
    root: &Path,
    fetched: bool,
    effects: &SyncEffects,
) -> Result<SyncPlan, StoreError> {
    ensure_on_main(root, effects.run_git)?;

    if (effects.read_entry)(&root.join(MERGE_HEAD))?.is_some() {
        return Err(StoreError::MergeInProgress {
            store: root.to_path_buf(),
        });
    }

    let changes = read_changes(root, effects.run_git)?;
    let mut plan = SyncPlan {
        fetched: if fetched {
            read_fetched(root, effects.run_git)?
        } else {
            None
        },
        ..SyncPlan::default()
    };
    let now = (effects.now)();

    for change in changes {
        plan_change(root, change, now, effects, &mut plan)?;
    }

    Ok(plan)
}

/// The production `read_entry`. The time is read again after the bytes, so a write during the
/// read makes the file count as changed just now.
pub(crate) fn read_entry(path: &Path) -> Result<Option<FileEntry>, StoreError> {
    let Some(before) = read_metadata(path)? else {
        return Ok(None);
    };
    let file_type = before.file_type();
    let (bytes, kind) = if file_type.is_symlink() {
        let target = fs::read_link(path).map_err(|source| io_error("read", path, source))?;

        (target.as_os_str().as_bytes().to_vec(), FileKind::Symlink)
    } else if file_type.is_file() {
        let bytes = fs::read(path).map_err(|source| io_error("read", path, source))?;
        let executable = before.permissions().mode() & 0o111 != 0;

        (
            bytes,
            if executable {
                FileKind::Executable
            } else {
                FileKind::File
            },
        )
    } else {
        return Ok(None);
    };
    let Some(after) = read_metadata(path)? else {
        return Ok(None);
    };
    let modified = modified_time(path, &before)?.max(modified_time(path, &after)?);

    Ok(Some(FileEntry {
        bytes,
        kind,
        modified,
    }))
}

fn read_metadata(path: &Path) -> Result<Option<fs::Metadata>, StoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(io_error("check", path, source)),
    }
}

fn modified_time(path: &Path, metadata: &fs::Metadata) -> Result<SystemTime, StoreError> {
    metadata
        .modified()
        .map_err(|source| io_error("read the change time of", path, source))
}

fn ensure_on_main(
    root: &Path,
    run_git: fn(&Path, &[&str]) -> Result<Vec<u8>, StoreError>,
) -> Result<(), StoreError> {
    let output = run_git(root, &["symbolic-ref", "--quiet", "HEAD"])?;
    let branch = String::from_utf8_lossy(&output).trim().to_owned();

    if branch != "refs/heads/main" {
        return Err(StoreError::NotOnMain {
            store: root.to_path_buf(),
            branch,
        });
    }

    Ok(())
}

/// The fetched `main` when it has commits that `HEAD` lacks. `for-each-ref` prints nothing when the
/// remote has no `main` yet, and fails only on a real error.
fn read_fetched(
    root: &Path,
    run_git: fn(&Path, &[&str]) -> Result<Vec<u8>, StoreError>,
) -> Result<Option<String>, StoreError> {
    let output = run_git(
        root,
        &[
            "for-each-ref",
            "--format=%(objectname)",
            "refs/remotes/origin/main",
        ],
    )?;
    let commit = String::from_utf8_lossy(&output).trim().to_owned();

    if commit.is_empty() {
        return Ok(None);
    }

    let output = run_git(root, &["rev-list", "--count", &format!("HEAD..{commit}")])?;
    let has_new_commits = String::from_utf8_lossy(&output).trim() != "0";

    Ok(has_new_commits.then_some(commit))
}

fn read_changes(
    root: &Path,
    run_git: fn(&Path, &[&str]) -> Result<Vec<u8>, StoreError>,
) -> Result<Vec<Change>, StoreError> {
    let output = run_git(
        root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--no-renames",
        ],
    )?;
    let mut changes = Vec::new();
    let mut staged = Vec::new();

    for entry in output.split(|byte| *byte == 0) {
        let [index, worktree, b' ', path @ ..] = entry else {
            continue;
        };

        if !matches!(index, b' ' | b'?') {
            staged.push(PathBuf::from(std::ffi::OsStr::from_bytes(path)));
            continue;
        }

        let Ok(path) = std::str::from_utf8(path) else {
            changes.push(Change::NameNotUtf8(
                String::from_utf8_lossy(path).into_owned(),
            ));
            continue;
        };
        let path = path.to_owned();

        changes.push(match (index, worktree) {
            (b'?', _) => Change::Added(path),
            (_, b'D') => Change::Deleted(path),
            _ => Change::Modified(path),
        });
    }

    if !staged.is_empty() {
        return Err(StoreError::StagedChanges {
            store: root.to_path_buf(),
            paths: staged,
        });
    }

    Ok(changes)
}

fn plan_change(
    root: &Path,
    change: Change,
    now: SystemTime,
    effects: &SyncEffects,
    plan: &mut SyncPlan,
) -> Result<(), StoreError> {
    let pending = |path: String, reason| PendingFile { path, reason };

    let (path, tracked) = match change {
        Change::NameNotUtf8(path) => {
            plan.pending.push(pending(path, PendingReason::NameNotUtf8));

            return Ok(());
        }
        Change::Deleted(path) if is_fact(&path) => {
            return Err(StoreError::FactRewritten {
                path: root.join(path),
            });
        }
        Change::Deleted(path) => {
            plan.remove.push(path);

            return Ok(());
        }
        Change::Added(path) => (path, false),
        Change::Modified(path) => (path, true),
    };

    if is_fact(&path) {
        return plan_fact(root, path, tracked, effects, plan);
    }

    let Some(entry) = (effects.read_entry)(&root.join(&path))? else {
        plan.pending.push(pending(path, PendingReason::Settling));

        return Ok(());
    };

    if !is_settled(entry.modified, now) {
        plan.pending.push(pending(path, PendingReason::Settling));
    } else if is_ticket_file(&path) && !parses(root, &path, &entry) {
        plan.pending.push(pending(path, PendingReason::Unparsed));
    } else {
        plan.stage.push(StagedFile {
            path,
            kind: entry.kind,
            bytes: entry.bytes,
        });
    }

    Ok(())
}

fn plan_fact(
    root: &Path,
    path: String,
    tracked: bool,
    effects: &SyncEffects,
    plan: &mut SyncPlan,
) -> Result<(), StoreError> {
    let entry = (effects.read_entry)(&root.join(&path))?;
    let rewritten = || StoreError::FactRewritten {
        path: root.join(&path),
    };

    let Some(entry) = entry else {
        return if tracked { Err(rewritten()) } else { Ok(()) };
    };

    if tracked {
        let committed = (effects.run_git)(root, &["cat-file", "blob", &format!("HEAD:{path}")])?;

        if entry.kind != FileKind::File || !entry.bytes.starts_with(&committed) {
            return Err(rewritten());
        }
    }

    plan.stage.push(StagedFile {
        path,
        kind: entry.kind,
        bytes: entry.bytes,
    });

    Ok(())
}

fn is_settled(modified: SystemTime, now: SystemTime) -> bool {
    now.duration_since(modified)
        .is_ok_and(|age| age >= SETTLE_TIME)
}

fn is_fact(path: &str) -> bool {
    Path::new(path).starts_with(FACTS_FOLDER)
}

fn is_ticket_file(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();

    matches!(parts.as_slice(), [TICKETS_FOLDER, _, name] if name.ends_with(".md"))
}

fn parses(root: &Path, path: &str, entry: &FileEntry) -> bool {
    let project = path.split('/').nth(1).unwrap_or_default();
    let Ok(project) = ProjectName::parse(project) else {
        return false;
    };

    entry.kind != FileKind::Symlink
        && parse_ticket(&root.join(path), &project, &entry.bytes).is_ok()
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{Change, is_fact, is_ticket_file, read_changes, read_entry};
    use crate::store::StoreError;

    fn status_output(_: &Path, _: &[&str]) -> Result<Vec<u8>, StoreError> {
        Ok(b"?? tickets/personal/new.md\0 M facts/laptop/2026-11.jsonl\0 D tickets/personal/gone.md\0?? odd-\xff\0".to_vec())
    }

    fn staged_output(_: &Path, _: &[&str]) -> Result<Vec<u8>, StoreError> {
        Ok(b" M tikk.json\0M  tickets/personal/staged.md\0".to_vec())
    }

    #[test]
    fn read_changes_sorts_each_status_entry_by_kind() {
        let changes = read_changes(Path::new("/store"), status_output).expect("the status parses");

        assert_eq!(
            changes,
            [
                Change::Added("tickets/personal/new.md".to_owned()),
                Change::Modified("facts/laptop/2026-11.jsonl".to_owned()),
                Change::Deleted("tickets/personal/gone.md".to_owned()),
                Change::NameNotUtf8("odd-\u{fffd}".to_owned()),
            ]
        );
    }

    #[test]
    fn read_entry_is_none_for_a_missing_file_and_an_error_when_it_cannot_check() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let file = directory.path().join("file");
        std::fs::write(&file, "text").expect("write a file");

        let missing = read_entry(&directory.path().join("missing"));
        let below_a_file = read_entry(&file.join("inside"));

        assert!(matches!(missing, Ok(None)), "{missing:?}");
        assert!(
            matches!(
                below_a_file,
                Err(StoreError::Io {
                    action: "check",
                    ..
                })
            ),
            "{below_a_file:?}"
        );
    }

    #[test]
    fn read_changes_refuses_a_staged_index() {
        let error =
            read_changes(Path::new("/store"), staged_output).expect_err("a staged file is refused");

        assert!(
            matches!(&error, StoreError::StagedChanges { paths, .. } if *paths == [PathBuf::from("tickets/personal/staged.md")]),
            "{error:?}"
        );
    }

    #[test]
    fn only_a_md_file_in_a_project_folder_is_a_ticket_file() {
        let cases = [
            ("tickets/personal/personal-abcd-a.md", true),
            ("tickets/personal/personal-abcd/design.md", false),
            ("tickets/personal/notes.txt", false),
            ("facts/laptop/2026-11.jsonl", false),
            ("tikk.json", false),
        ];

        for (path, expected) in cases {
            assert_eq!(is_ticket_file(path), expected, "case {path}");
        }
    }

    #[test]
    fn a_fact_is_a_path_under_the_facts_folder() {
        assert!(is_fact("facts/laptop/2026-11.jsonl"));
        assert!(!is_fact("factsheet.md"));
        assert!(!is_fact("tickets/facts/x.md"));
    }
}
