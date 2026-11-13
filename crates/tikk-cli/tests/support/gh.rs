use std::path::{Path, PathBuf};

use serde_json::json;
use tempfile::{Builder, TempDir};

const SCRIPT: &str = r#"#!/bin/sh
root=$(cd "$(dirname "$0")/.." && pwd)
printf '%s\n' "$*" >> "$root/calls.log"
case "$1 $2" in
  "pr view") key="pr/${5#github.com/}/$3" ;;
  "repo view") key="repo/${3#github.com/}" ;;
  "api --hostname") key="api/$4" ;;
  *) echo "fake gh: unexpected call: $*" >&2; exit 2 ;;
esac
if [ -f "$root/responses/$key.fail" ]; then
  cat "$root/responses/$key.fail" >&2
  exit 1
fi
if [ -f "$root/responses/$key.json" ]; then
  cat "$root/responses/$key.json"
  exit 0
fi
echo "fake gh: no answer for $*" >&2
exit 2
"#;

pub(crate) const TRUNK: &str = "main";

pub(crate) struct FakeGh {
    directory: TempDir,
}

impl FakeGh {
    pub(crate) fn new() -> Self {
        use std::os::unix::fs::PermissionsExt as _;

        let directory = Builder::new()
            .prefix("tikk-cli-gh-")
            .tempdir()
            .expect("create a temporary directory");
        let bin = directory.path().join("bin");
        std::fs::create_dir(&bin).expect("create the fake gh folder");
        let script = bin.join("gh");
        std::fs::write(&script, SCRIPT).expect("write the fake gh");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .expect("make the fake gh executable");

        Self { directory }
    }

    pub(crate) fn bin(&self) -> PathBuf {
        self.directory.path().join("bin")
    }

    pub(crate) fn open_pr(&self, repository: &str, number: u64, head: &str) {
        self.pull_request(repository, number, "OPEN", TRUNK, head, None);
    }

    pub(crate) fn merged_pr(
        &self,
        repository: &str,
        number: u64,
        base: &str,
        head: &str,
        merge_commit: &str,
    ) {
        self.pull_request(repository, number, "MERGED", base, head, Some(merge_commit));
    }

    pub(crate) fn pull_request(
        &self,
        repository: &str,
        number: u64,
        state: &str,
        base: &str,
        head: &str,
        merge_commit: Option<&str>,
    ) {
        let merge_commit = merge_commit.map(|oid| json!({ "oid": oid }));
        let view = json!({
            "number": number,
            "state": state,
            "baseRefName": base,
            "headRefOid": head,
            "mergeCommit": merge_commit,
        });

        self.answer(&format!("pr/{repository}/{number}"), &view.to_string());
        self.answer(
            &format!("repo/{repository}"),
            &json!({ "defaultBranchRef": { "name": TRUNK } }).to_string(),
        );
    }

    pub(crate) fn compare(&self, repository: &str, merge_commit: &str, status: &str) {
        self.answer(
            &format!("api/repos/{repository}/compare/{TRUNK}...{merge_commit}"),
            &json!({ "status": status }).to_string(),
        );
    }

    pub(crate) fn fail_pr(&self, repository: &str, number: u64, message: &str) {
        let path = self.response(&format!("pr/{repository}/{number}"), "fail");

        std::fs::write(path, message).expect("write a fake gh failure");
    }

    pub(crate) fn answer(&self, key: &str, text: &str) {
        let path = self.response(key, "json");

        std::fs::write(path, text).expect("write a fake gh answer");
    }

    pub(crate) fn calls(&self) -> Vec<String> {
        match std::fs::read_to_string(self.directory.path().join("calls.log")) {
            Ok(text) => text.lines().map(str::to_owned).collect(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => panic!("read the fake gh calls: {error}"),
        }
    }

    fn response(&self, key: &str, extension: &str) -> PathBuf {
        let path = self
            .directory
            .path()
            .join("responses")
            .join(format!("{key}.{extension}"));
        let folder = path.parent().expect("an answer is inside a folder");

        std::fs::create_dir_all(folder).expect("create the fake gh answer folder");
        remove_if_present(&path.with_extension(if extension == "json" { "fail" } else { "json" }));

        path
    }
}

fn remove_if_present(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => panic!("remove {path:?}: {error}"),
    }
}

pub(crate) fn pr_view_call(repository: &str, number: u64) -> String {
    format!(
        "pr view {number} --repo github.com/{repository} --json number,state,baseRefName,headRefOid,mergeCommit"
    )
}
