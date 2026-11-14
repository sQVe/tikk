use std::fs;
use std::path::{Path, PathBuf};

use tempfile::TempDir;

use crate::store::git::run_store_git;
use crate::store::{MachineName, RemoteInitEffects, init_from_remote};

pub(crate) fn bare_remote() -> TempDir {
    let remote = tempfile::tempdir().expect("create the remote folder");
    run_store_git(
        remote.path(),
        &["init", "--quiet", "--bare", "--initial-branch=main"],
    )
    .expect("create the bare remote");

    remote
}

pub(crate) fn store_on_remote(remote: &Path, machine: &str) -> TempDir {
    let directory = tempfile::tempdir().expect("create a temporary directory");
    init_from_remote(
        directory.path(),
        remote.to_str().expect("a UTF-8 path"),
        Some(MachineName::parse(machine).expect("a valid machine name")),
        &RemoteInitEffects::system(),
    )
    .expect("init from the remote");

    directory
}

pub(crate) fn git_text(root: &Path, arguments: &[&str]) -> String {
    String::from_utf8(run_store_git(root, arguments).expect("git runs")).expect("UTF-8 output")
}

// A symlink's bytes are its target.
pub(crate) fn store_files(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut files = Vec::new();

    collect_files(root, root, &mut files);
    files.sort();

    files
}

fn collect_files(root: &Path, folder: &Path, files: &mut Vec<(PathBuf, Vec<u8>)>) {
    for entry in fs::read_dir(folder).expect("list a folder") {
        let path = entry.expect("read an entry").path();

        if path.ends_with(".git") {
            continue;
        }

        if path.is_symlink() {
            let relative = path
                .strip_prefix(root)
                .expect("inside the store")
                .to_owned();
            let target = fs::read_link(&path).expect("read a symlink");

            files.push((relative, target.into_os_string().into_encoded_bytes()));
        } else if path.is_dir() {
            collect_files(root, &path, files);
        } else {
            let relative = path
                .strip_prefix(root)
                .expect("inside the store")
                .to_owned();

            files.push((relative, fs::read(&path).expect("read a file")));
        }
    }
}
