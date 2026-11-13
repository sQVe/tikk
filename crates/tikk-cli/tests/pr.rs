mod support;

use serde_json::json;

use support::{FakeGh, Home, parse_json, pr_view_call};

const REPOSITORY: &str = "owner/app";
const URL: &str = "https://github.com/owner/app/pull/7";
const HEAD: &str = "1111111111111111111111111111111111111111";

#[test]
fn pr_link_records_an_open_pr_that_show_returns_with_its_check_time() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (_plan, slice) = home.plan_and_slice();
    gh.open_pr(REPOSITORY, 7, HEAD);

    let link = home.tikk_with_gh(&gh, None, &["pr", "link", &slice, URL, "--json"]);

    assert_eq!(link.exit_code, 0, "link: {}", link.stderr);
    let shown = home.show_json(&slice);
    let pr = &shown["pr"];
    assert_eq!(pr["repository"], json!(REPOSITORY), "{shown}");
    assert_eq!(pr["number"], json!(7), "{shown}");
    assert_eq!(pr["state"], json!("open"), "{shown}");
    assert_eq!(pr["head"], json!(HEAD), "{shown}");
    assert_eq!(pr["inTrunk"], json!(false), "{shown}");
    assert!(pr["prCheckedAt"].is_string(), "{shown}");
    assert_eq!(gh.calls(), [pr_view_call(REPOSITORY, 7)]);
}

const MERGE: &str = "2222222222222222222222222222222222222222";

fn linked_slice(home: &Home, gh: &FakeGh, number: u64) -> String {
    let (_plan, slice) = home.plan_and_slice();
    let url = format!("https://github.com/{REPOSITORY}/pull/{number}");
    gh.open_pr(REPOSITORY, number, HEAD);
    let link = home.tikk_with_gh(gh, None, &["pr", "link", &slice, &url, "--json"]);

    assert_eq!(link.exit_code, 0, "link: {}", link.stderr);

    slice
}

fn pr_facts(home: &Home) -> Vec<serde_json::Value> {
    home.fact_lines()
        .into_iter()
        .filter(|fact| fact["kind"] == json!("pr"))
        .collect()
}

#[test]
fn pr_link_prints_the_recorded_pr() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (_plan, slice) = home.plan_and_slice();
    gh.open_pr(REPOSITORY, 7, HEAD);

    let link = home.tikk_with_gh(&gh, None, &["pr", "link", &slice, URL, "--json"]);

    assert_eq!(link.exit_code, 0, "link: {}", link.stderr);
    let printed = parse_json(&link.stdout);
    assert_eq!(printed["id"], json!(slice));
    assert_eq!(
        printed["pr"],
        json!({
            "repository": REPOSITORY,
            "number": 7,
            "url": URL,
            "state": "open",
            "base": "main",
            "head": HEAD,
            "mergeCommit": null,
            "inTrunk": false,
            "prCheckedAt": pr_facts(&home)[0]["at"],
        })
    );
}

#[test]
fn ready_and_show_read_the_recorded_pr_and_never_run_gh() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let slice = linked_slice(&home, &gh, 7);
    let before = gh.calls();

    let show = home.tikk_with_gh(&gh, None, &["show", &slice, "--json"]);
    let ready = home.tikk_with_gh(&gh, None, &["ready", "--project", "personal", "--json"]);

    assert_eq!(show.exit_code, 0, "show: {}", show.stderr);
    assert_eq!(ready.exit_code, 0, "ready: {}", ready.stderr);
    assert_eq!(parse_json(&show.stdout)["pr"]["state"], json!("open"));
    assert_eq!(gh.calls(), before);
}

#[test]
fn pr_refresh_records_a_merge_into_trunk_and_then_reads_that_pr_no_more() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let slice = linked_slice(&home, &gh, 7);
    gh.merged_pr(REPOSITORY, 7, support::TRUNK, HEAD, MERGE);

    let refresh = home.tikk_with_gh(&gh, None, &["pr", "refresh", "--json"]);

    assert_eq!(refresh.exit_code, 0, "refresh: {}", refresh.stderr);
    let facts = pr_facts(&home);
    let last = facts.last().expect("the refresh appends a fact");
    assert_eq!(facts.len(), 2);
    assert_eq!(last["state"], json!("merged"));
    assert_eq!(last["mergeCommit"], json!(MERGE));
    assert_eq!(last["inTrunk"], json!(true));
    assert_eq!(
        parse_json(&refresh.stdout)["refreshed"][0]["id"],
        json!(slice)
    );
    let before = gh.calls();

    let again = home.tikk_with_gh(&gh, None, &["pr", "refresh", "--json"]);

    assert_eq!(again.exit_code, 0, "second refresh: {}", again.stderr);
    assert_eq!(parse_json(&again.stdout), json!({ "refreshed": [] }));
    assert_eq!(gh.calls(), before, "the second refresh runs no gh");
    assert_eq!(pr_facts(&home).len(), 2);
}

#[test]
fn pr_refresh_of_a_named_slice_reads_its_pr_even_when_it_is_in_trunk() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let slice = linked_slice(&home, &gh, 7);
    gh.merged_pr(REPOSITORY, 7, support::TRUNK, HEAD, MERGE);
    let first = home.tikk_with_gh(&gh, None, &["pr", "refresh", "--json"]);
    assert_eq!(first.exit_code, 0, "refresh: {}", first.stderr);

    let named = home.tikk_with_gh(&gh, None, &["pr", "refresh", &slice, "--json"]);

    assert_eq!(named.exit_code, 0, "named refresh: {}", named.stderr);
    assert_eq!(pr_facts(&home).len(), 3);
    assert_eq!(
        home.show_json(&slice)["pr"]["prCheckedAt"],
        pr_facts(&home)[2]["at"]
    );
}

#[test]
fn a_pr_merged_into_another_branch_is_in_trunk_only_once_trunk_holds_its_merge_commit() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let slice = linked_slice(&home, &gh, 7);
    gh.merged_pr(REPOSITORY, 7, "feature", HEAD, MERGE);
    gh.compare(REPOSITORY, MERGE, "ahead");

    let before_trunk = home.tikk_with_gh(&gh, None, &["pr", "refresh", "--json"]);

    assert_eq!(
        before_trunk.exit_code, 0,
        "refresh: {}",
        before_trunk.stderr
    );
    let shown = home.show_json(&slice);
    assert_eq!(shown["pr"]["state"], json!("merged"), "{shown}");
    assert_eq!(shown["pr"]["inTrunk"], json!(false), "{shown}");
    gh.compare(REPOSITORY, MERGE, "behind");

    let in_trunk = home.tikk_with_gh(&gh, None, &["pr", "refresh", "--json"]);

    assert_eq!(in_trunk.exit_code, 0, "refresh: {}", in_trunk.stderr);
    assert_eq!(home.show_json(&slice)["pr"]["inTrunk"], json!(true));
    assert!(
        gh.calls()
            .contains(&format!("api repos/{REPOSITORY}/compare/main...{MERGE}")),
        "{:?}",
        gh.calls()
    );
}

#[test]
fn pr_refresh_records_the_prs_it_read_and_names_the_one_gh_failed_for() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let first = linked_slice(&home, &gh, 7);
    let second = linked_slice(&home, &gh, 8);
    gh.pull_request(REPOSITORY, 7, "CLOSED", "main", HEAD, None);
    gh.fail_pr(REPOSITORY, 8, "HTTP 502: Bad Gateway");

    let refresh = home.tikk_with_gh(&gh, None, &["pr", "refresh", "--json"]);

    assert_eq!(refresh.exit_code, 1, "refresh");
    assert_eq!(refresh.stdout, "");
    let error = &parse_json(&refresh.stderr)["error"];
    assert_eq!(error["code"], json!("ghError"));
    assert_eq!(error["pullRequests"][0]["id"], json!(second), "{error}");
    assert_eq!(error["pullRequests"][0]["number"], json!(8), "{error}");
    assert_eq!(error["pullRequests"].as_array().map(Vec::len), Some(1));
    let message = error["message"].as_str().expect("a message");
    assert!(
        message.contains("https://github.com/owner/app/pull/8") && message.contains("HTTP 502"),
        "{message}"
    );
    assert_eq!(home.show_json(&first)["pr"]["state"], json!("closed"));
    assert_eq!(home.show_json(&second)["pr"]["state"], json!("open"));
}

#[test]
fn pr_link_without_gh_on_path_exits_with_gh_error() {
    let home = Home::initialized();
    let empty = tempfile::tempdir().expect("create an empty folder");
    let (_plan, slice) = home.plan_and_slice();

    let link = home.tikk_on_path(
        empty.path().as_os_str().to_owned(),
        None,
        &["pr", "link", &slice, URL, "--json"],
    );

    assert_eq!(link.exit_code, 1, "link");
    let error = &parse_json(&link.stderr)["error"];
    assert_eq!(error["code"], json!("ghError"), "{error}");
    assert_eq!(error["pullRequests"][0]["url"], json!(URL), "{error}");
    assert_eq!(pr_facts(&home), Vec::<serde_json::Value>::new());
}

#[test]
fn pr_link_by_another_agent_on_a_claimed_slice_is_refused_and_by_the_holder_renews_the_lease() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (_plan, slice) = home.plan_and_slice();
    gh.open_pr(REPOSITORY, 7, HEAD);
    let claim = home.tikk_as("manager", &["claim", &slice, "--json"]);
    assert_eq!(claim.exit_code, 0, "claim: {}", claim.stderr);
    let claimed_end = parse_json(&claim.stdout)["claim"]["leaseEnd"].clone();
    let before = home.store_files();

    let other = home.tikk_with_gh(&gh, Some("other"), &["pr", "link", &slice, URL, "--json"]);

    assert_eq!(other.exit_code, 1, "another agent's link");
    assert_eq!(parse_json(&other.stderr)["error"]["code"], json!("claimed"));
    assert_eq!(
        home.store_files(),
        before,
        "the refused link writes nothing"
    );
    assert_eq!(
        gh.calls(),
        Vec::<String>::new(),
        "the refused link runs no gh"
    );

    let holder = home.tikk_with_gh(&gh, Some("manager"), &["pr", "link", &slice, URL, "--json"]);

    assert_eq!(holder.exit_code, 0, "the holder's link: {}", holder.stderr);
    let renewed_end = home.show_json(&slice)["claim"]["leaseEnd"].clone();
    assert!(
        renewed_end.as_str() > claimed_end.as_str(),
        "the link moves leaseEnd from {claimed_end} to {renewed_end}"
    );
}

#[test]
fn pr_link_refuses_a_url_that_is_not_a_pr_and_a_ticket_that_is_not_a_slice() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (plan, slice) = home.plan_and_slice();
    gh.open_pr(REPOSITORY, 7, HEAD);

    let bad_url = home.tikk_with_gh(
        &gh,
        None,
        &[
            "pr",
            "link",
            &slice,
            "https://github.com/owner/app/issues/7",
            "--json",
        ],
    );
    let plan_link = home.tikk_with_gh(&gh, None, &["pr", "link", &plan, URL, "--json"]);

    assert_eq!(bad_url.exit_code, 2, "a URL that is not a PR");
    assert_eq!(
        parse_json(&bad_url.stderr)["error"]["code"],
        json!("invalidArguments")
    );
    assert_eq!(plan_link.exit_code, 1, "a plan");
    assert_eq!(
        parse_json(&plan_link.stderr)["error"]["code"],
        json!("wrongKind")
    );
    assert_eq!(gh.calls(), Vec::<String>::new());
}

#[test]
fn pr_refresh_of_all_refuses_a_linked_slice_whose_id_is_shared_before_gh_runs() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let healthy = linked_slice(&home, &gh, 7);
    let shared = linked_slice(&home, &gh, 8);
    let paths = home.share_id(&shared);
    let calls = gh.calls();
    let before = home.store_files();

    let refresh = home.tikk_with_gh(&gh, None, &["pr", "refresh", "--json"]);

    assert_eq!(refresh.exit_code, 1, "refresh: {}", refresh.stdout);
    let error = &parse_json(&refresh.stderr)["error"];
    assert_eq!(error["code"], json!("idShared"), "{error}");
    assert_eq!(error["files"], json!(paths), "{error}");
    assert!(
        error["message"]
            .as_str()
            .is_some_and(|message| message.contains(&shared)),
        "{error}"
    );
    assert_eq!(gh.calls(), calls, "the refusal runs no gh");
    assert_eq!(home.store_files(), before, "the refusal writes nothing");
    assert_ne!(healthy, shared);
}

#[test]
fn pr_refresh_of_a_slice_without_a_pr_exits_with_not_linked() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (_plan, slice) = home.plan_and_slice();

    let refresh = home.tikk_with_gh(&gh, None, &["pr", "refresh", &slice, "--json"]);

    assert_eq!(refresh.exit_code, 1, "refresh");
    assert_eq!(
        parse_json(&refresh.stderr)["error"]["code"],
        json!("notLinked")
    );
}

#[test]
fn pr_link_show_and_refresh_print_the_pr_as_text() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (_plan, slice) = home.plan_and_slice();
    gh.open_pr(REPOSITORY, 7, HEAD);
    let state = format!("{URL} open at {HEAD}, checked ");

    let link = home.tikk_with_gh(&gh, None, &["pr", "link", &slice, URL]);
    let show = home.tikk(&["show", &slice]);
    let refresh = home.tikk_with_gh(&gh, None, &["pr", "refresh"]);

    assert!(
        link.stdout.starts_with(&format!("{slice}  {state}")),
        "{}",
        link.stdout
    );
    assert!(
        show.stdout.contains(&format!("\npr: {state}")),
        "{}",
        show.stdout
    );
    assert!(
        refresh.stdout.starts_with(&format!("{slice}  {state}")),
        "{}",
        refresh.stdout
    );
}
