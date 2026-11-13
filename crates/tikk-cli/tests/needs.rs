mod support;

use serde_json::{Value, json};

use support::audit::{REPOSITORY, linked_slice, merge_and_refresh};
use support::{FakeGh, Home, Remote, parse_json};

fn needs(home: &Home) -> Value {
    let run = home.tikk(&["needs", "--json"]);

    assert_eq!(run.exit_code, 0, "needs: {}", run.stderr);

    parse_json(&run.stdout)
}

fn stale_claim_line(slice: &str) -> String {
    format!(
        "{{\"v\":1,\"kind\":\"claim\",\"ticket\":\"{slice}\",\"at\":\"2020-01-01T00:00:00Z\",\"agent\":\"manager-1\",\"session\":null,\"sessionLog\":null,\"leaseEnd\":\"2020-01-01T04:00:00Z\"}}"
    )
}

#[test]
fn an_empty_store_needs_nothing() {
    let home = Home::initialized();

    let text = home.tikk(&["needs"]);

    assert_eq!(needs(&home), json!({ "items": [], "problems": [] }));
    assert_eq!(text.exit_code, 0, "{}", text.stderr);
    assert_eq!(text.stdout, "Nothing waits on you.\n");
}

#[test]
fn a_loose_open_task_is_listed_until_it_moves_under_a_plan() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let task = home.new_ticket(&["task", "Renew the domain"]);
    let done = home.new_ticket(&["task", "Pay the bill"]);
    let marked = home.tikk(&["done", &done]);
    assert_eq!(marked.exit_code, 0, "done: {}", marked.stderr);

    let before = needs(&home);
    let moved = home.tikk(&["move", &task, "--parent", &plan]);

    assert_eq!(
        before["items"],
        json!([{ "reason": "looseTask", "id": task }])
    );
    assert_eq!(moved.exit_code, 0, "move: {}", moved.stderr);
    assert_eq!(needs(&home)["items"], json!([]));
}

#[test]
fn an_open_task_that_blocks_an_open_slice_is_listed_and_names_the_slice() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let task = home.new_ticket(&["task", "Pick a license", "--parent", &plan]);
    let slice = home.slice_under(&plan, "Add the store", &[&task]);

    let listed = needs(&home);
    let text = home.tikk(&["needs"]);

    assert_eq!(
        listed["items"],
        json!([{ "reason": "blockingTask", "id": task, "blocks": [slice] }])
    );
    assert_eq!(
        text.stdout,
        format!("{task}  blockingTask: blocks {slice}\n")
    );
}

#[test]
fn a_slice_whose_lease_ended_is_listed_with_its_holder() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();
    home.append_fact_line("2020-01.jsonl", &stale_claim_line(&slice));

    assert_eq!(
        needs(&home)["items"],
        json!([{
            "reason": "staleClaim",
            "id": slice,
            "holder": "manager-1",
            "leaseEnd": "2020-01-01T04:00:00.000Z",
        }])
    );
}

#[test]
fn a_merged_slice_with_no_audit_is_listed_with_its_pr_and_needs_runs_no_gh() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (_plan, slice) = linked_slice(&home, &gh);
    merge_and_refresh(&home, &gh, 7, support::audit::HEAD);
    let shown_pr = home.show_json(&slice)["pr"].clone();
    let calls = gh.calls();

    let run = home.tikk_with_gh(&gh, None, &["needs", "--json"]);

    assert_eq!(run.exit_code, 0, "needs: {}", run.stderr);
    assert_eq!(gh.calls(), calls, "needs runs no gh");
    let items = &parse_json(&run.stdout)["items"];
    assert_eq!(
        items,
        &json!([{
            "reason": "mergedUnverified",
            "id": slice,
            "pr": shown_pr,
            "prCheckedAt": shown_pr["prCheckedAt"],
        }])
    );
    assert_eq!(items[0]["pr"]["repository"], json!(REPOSITORY));
    assert!(items[0]["prCheckedAt"].is_string(), "{items}");
}

#[test]
fn a_sync_that_stopped_on_a_conflict_is_listed_with_the_file() {
    let remote = Remote::new();
    let laptop = Home::on_remote(&remote, "laptop");
    let desktop = Home::on_remote(&remote, "desktop");
    let id = laptop.new_ticket(&["task", "Renew the domain"]);
    let move_under = laptop.new_ticket(&["plan", "Keep the domain"]);
    let moved = laptop.tikk(&["move", &id, "--parent", &move_under]);
    assert_eq!(moved.exit_code, 0, "move: {}", moved.stderr);
    laptop.settle_files();
    laptop.sync_json();
    desktop.sync_json();
    let laptop_path = laptop.show_json(&id)["path"].as_str().map(str::to_owned);
    let desktop_path = desktop.show_json(&id)["path"].as_str().map(str::to_owned);
    let laptop_path = laptop_path.expect("show prints the path");
    let desktop_path = desktop_path.expect("show prints the path");
    std::fs::write(
        &laptop_path,
        format!("---\nkind: task\ntitle: Renew for one year\nparent: {move_under}\n---\n"),
    )
    .expect("edit on the laptop");
    std::fs::write(
        &desktop_path,
        format!("---\nkind: task\ntitle: Renew for two years\nparent: {move_under}\n---\n"),
    )
    .expect("edit on the desktop");
    laptop.settle_files();
    desktop.settle_files();
    laptop.sync_json();
    let sync = desktop.tikk(&["sync", "--json"]);
    assert_eq!(sync.exit_code, 1, "{}", sync.stderr);

    let listed = needs(&desktop);

    let relative = std::path::Path::new(&desktop_path)
        .strip_prefix(desktop.store())
        .expect("inside the store")
        .to_str()
        .expect("a UTF-8 path")
        .to_owned();
    let problems = listed["problems"].as_array().expect("needs lists problems");
    assert_eq!(problems.len(), 1, "{listed}");
    assert_eq!(problems[0]["code"], json!("syncFailed"));
    assert_eq!(problems[0]["files"], json!([relative]));
    assert_eq!(
        problems[0]["message"],
        parse_json(&sync.stderr)["error"]["message"]
    );
    assert_eq!(listed["items"], json!([]));
}

#[test]
fn a_broken_ticket_file_an_id_clash_and_a_broken_fact_line_are_problems() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let shared = home.share_id(&plan);
    let broken = home
        .store()
        .join("tickets/personal/personal-9999-broken.md");
    std::fs::write(&broken, "kind: task\n").expect("write a broken ticket");
    home.append_fact_line("2026-11.jsonl", "{\"v\":1,");

    let listed = needs(&home);

    let problems = listed["problems"].as_array().expect("needs lists problems");
    let codes: Vec<&Value> = problems.iter().map(|problem| &problem["code"]).collect();
    assert_eq!(
        codes,
        [
            &json!("parseError"),
            &json!("idShared"),
            &json!("factUnreadable")
        ],
        "{listed}"
    );
    assert_eq!(problems[0]["path"], json!(broken.to_str()));
    assert_eq!(problems[1]["id"], json!(plan));
    assert_eq!(problems[1]["paths"], json!(shared));
    assert!(
        problems[2]["path"]
            .as_str()
            .is_some_and(|path| path.ends_with("facts/test/2026-11.jsonl")),
        "{listed}"
    );
    assert_eq!(problems[2]["line"], json!(1));
    assert_eq!(listed["items"], json!([]));
}

#[test]
fn a_store_with_no_remote_lists_no_fetch_problem_after_a_claim_a_release_or_a_sync() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();
    let steps: [&[&str]; 3] = [
        &["claim", &slice, "--json"],
        &["release", &slice, "--json"],
        &["sync", "--json"],
    ];

    for arguments in steps {
        let run = home.tikk_as("manager", arguments);
        assert_eq!(run.exit_code, 0, "{arguments:?}: {}", run.stderr);

        assert_eq!(
            needs(&home),
            json!({ "items": [], "problems": [] }),
            "after {arguments:?}"
        );
    }
}

#[test]
fn a_store_whose_remote_cannot_be_fetched_lists_the_fetch_problem() {
    let remote = Remote::new();
    let home = Home::on_remote(&remote, "test");
    let missing = remote.path().join("missing.git");
    home.git(&[
        "remote",
        "set-url",
        "origin",
        missing.to_str().expect("a UTF-8 path"),
    ]);
    home.sync_json();

    let problems = &needs(&home)["problems"];

    assert_eq!(problems[0]["code"], json!("syncProblem"), "{problems}");
    assert_eq!(problems[0]["step"], json!("fetch"), "{problems}");
}
