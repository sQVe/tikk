use std::io::Write as _;
use std::path::Path;

use crate::store::StoreError;
use crate::store::sync::FileKind;
use crate::store::sync_read::SyncPlan;
use crate::store::ticket_files::io_error;

const COMMIT_MESSAGE: &str = "Sync the tikk store";
const GIT_FOLDER: &str = ".git";

/// Stages the checked bytes of the plan, not the files as they are now, and commits them. A plan
/// with nothing to commit changes nothing. Sync refuses an index with staged changes before this
/// runs, so when staging or the commit fails, every staged path is its own, and it unstages them.
pub(crate) fn commit_plan(
    root: &Path,
    plan: &SyncPlan,
    run_git: fn(&Path, &[&str]) -> Result<Vec<u8>, StoreError>,
) -> Result<(), StoreError> {
    if plan.stage.is_empty() && plan.remove.is_empty() {
        return Ok(());
    }

    let Err(cause) = stage_and_commit(root, plan, run_git) else {
        return Ok(());
    };
    let paths = plan.committed_paths();
    let mut arguments = vec!["--literal-pathspecs", "reset", "--quiet", "--"];

    arguments.extend(paths.iter().map(String::as_str));

    match run_git(root, &arguments) {
        Ok(_) => Err(cause),
        Err(unstage) => Err(StoreError::UnstageFailed {
            store: root.to_path_buf(),
            cause: Box::new(cause),
            unstage: Box::new(unstage),
        }),
    }
}

fn stage_and_commit(
    root: &Path,
    plan: &SyncPlan,
    run_git: fn(&Path, &[&str]) -> Result<Vec<u8>, StoreError>,
) -> Result<(), StoreError> {
    let mut entries = Vec::new();

    for file in &plan.stage {
        let blob = write_blob(root, &file.bytes, run_git)?;

        entries.push(format!("{},{blob},{}", mode(file.kind), file.path));
    }

    if !entries.is_empty() {
        let mut arguments = vec!["update-index", "--add"];

        for entry in &entries {
            arguments.extend(["--cacheinfo", entry.as_str()]);
        }

        run_git(root, &arguments)?;
    }

    if !plan.remove.is_empty() {
        let mut arguments = vec!["update-index", "--force-remove", "--"];

        arguments.extend(plan.remove.iter().map(String::as_str));
        run_git(root, &arguments)?;
    }

    run_git(
        root,
        &[
            "commit",
            "--quiet",
            "--no-verify",
            "--message",
            COMMIT_MESSAGE,
        ],
    )?;

    Ok(())
}

/// Git hashes a file, so the bytes go to a temporary file in `.git`, named by a path relative to
/// the store, which stays UTF-8 when the store path is not.
fn write_blob(
    root: &Path,
    bytes: &[u8],
    run_git: fn(&Path, &[&str]) -> Result<Vec<u8>, StoreError>,
) -> Result<String, StoreError> {
    let folder = root.join(GIT_FOLDER);
    let mut file = tempfile::Builder::new()
        .prefix("tikk-sync-blob-")
        .tempfile_in(&folder)
        .map_err(|source| io_error("create a file in", &folder, source))?;

    file.write_all(bytes)
        .and_then(|()| file.flush())
        .map_err(|source| io_error("write", file.path(), source))?;

    let name = file
        .path()
        .file_name()
        .expect("a temporary file has a name")
        .to_string_lossy()
        .into_owned();
    let relative = format!("{GIT_FOLDER}/{name}");
    let output = run_git(
        root,
        &["hash-object", "-w", "--no-filters", "--", &relative],
    )?;

    Ok(String::from_utf8_lossy(&output).trim().to_owned())
}

fn mode(kind: FileKind) -> &'static str {
    match kind {
        FileKind::File => "100644",
        FileKind::Executable => "100755",
        FileKind::Symlink => "120000",
    }
}
