use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::{FakeGh, Home, Run, TRUNK};

pub(crate) const REPOSITORY: &str = "owner/app";
pub(crate) const HEAD: &str = "1111111111111111111111111111111111111111";
pub(crate) const NEW_HEAD: &str = "2222222222222222222222222222222222222222";

pub(crate) fn link_open_pr(home: &Home, gh: &FakeGh, slice: &str, number: u64) {
    let url = format!("https://github.com/{REPOSITORY}/pull/{number}");
    gh.open_pr(REPOSITORY, number, HEAD);

    let link = home.tikk_with_gh(gh, None, &["pr", "link", slice, &url, "--json"]);

    assert_eq!(link.exit_code, 0, "pr link: {}", link.stderr);
}

pub(crate) fn linked_slice(home: &Home, gh: &FakeGh) -> (String, String) {
    let (plan, slice) = home.plan_and_slice();

    link_open_pr(home, gh, &slice, 7);

    (plan, slice)
}

pub(crate) fn merge_and_refresh(home: &Home, gh: &FakeGh, number: u64, head: &str) {
    gh.merged_pr(
        REPOSITORY,
        number,
        TRUNK,
        head,
        "3333333333333333333333333333333333333333",
    );

    let refresh = home.tikk_with_gh(gh, None, &["pr", "refresh", "--json"]);

    assert_eq!(refresh.exit_code, 0, "pr refresh: {}", refresh.stderr);
}

pub(crate) fn verdicts(home: &Home, verdicts: &Value) -> PathBuf {
    home.document("verdicts.json", &verdicts.to_string())
}

pub(crate) fn met(criterion: &str) -> Value {
    json!({ "criterion": criterion, "verdict": "met", "evidence": "The tests pass." })
}

pub(crate) fn hash_of(home: &Home, id: &str) -> String {
    home.show_json(id)["hash"]
        .as_str()
        .expect("show prints the hash")
        .to_owned()
}

pub(crate) fn audit(home: &Home, agent: Option<&str>, slice: &str, head: &str, file: &Path) -> Run {
    audit_with_hash(home, agent, slice, &hash_of(home, slice), head, file)
}

pub(crate) fn audit_with_hash(
    home: &Home,
    agent: Option<&str>,
    slice: &str,
    hash: &str,
    head: &str,
    file: &Path,
) -> Run {
    let arguments = [
        "audit",
        slice,
        "--hash",
        hash,
        "--head",
        head,
        "--repository",
        REPOSITORY,
        "--file",
        file.to_str().expect("a UTF-8 path"),
        "--json",
    ];

    match agent {
        Some(agent) => home.tikk_as(agent, &arguments),
        None => home.tikk(&arguments),
    }
}

pub(crate) fn audit_met(home: &Home, slice: &str) {
    let file = verdicts(home, &json!([met("s1")]));

    let run = audit(home, None, slice, HEAD, &file);

    assert_eq!(run.exit_code, 0, "audit: {}", run.stderr);
}
