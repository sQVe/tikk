mod support;

use serde_json::{Value, json};

use support::audit::{HEAD, audit_met, link_open_pr, merge_and_refresh};
use support::{FakeGh, Home, Remote, parse_json};

fn needs(home: &Home, gh: &FakeGh, step: &str) -> Value {
    let calls = gh.calls();
    let run = home.tikk_with_gh(gh, None, &["needs", "--json"]);

    assert_eq!(run.exit_code, 0, "{step}, needs: {}", run.stderr);
    assert_eq!(gh.calls(), calls, "{step}, needs runs no gh");

    parse_json(&run.stdout)
}

#[test]
fn what_waits_on_the_user() {
    let remote = Remote::new();
    let home = Home::on_remote(&remote, "test");
    let gh = FakeGh::new();
    let (plan, slice) = home.plan_and_slice();

    let asked = home.tikk_as(
        "manager",
        &["ask", &slice, "--text", "Which crate?", "--json"],
    );

    assert_eq!(asked.exit_code, 0, "step 1, ask: {}", asked.stderr);
    let item = parse_json(&asked.stdout)["item"]
        .as_str()
        .expect("ask prints the item ID")
        .to_owned();
    assert_eq!(
        needs(&home, &gh, "step 1")["items"],
        json!([{ "reason": "question", "id": slice, "item": item, "text": "Which crate?" }]),
        "step 1, needs lists the question"
    );

    let answer = home.tikk(&["answer", &slice, &item, "--text", "serde-saphyr", "--json"]);

    assert_eq!(answer.exit_code, 0, "step 2, answer: {}", answer.stderr);
    assert_eq!(
        needs(&home, &gh, "step 2")["items"],
        json!([]),
        "step 2, needs no longer lists the question"
    );
    let agent_show = home.tikk_as("manager", &["show", &slice, "--json"]);
    assert_eq!(
        agent_show.exit_code, 0,
        "step 2, show: {}",
        agent_show.stderr
    );
    let questions = &parse_json(&agent_show.stdout)["questions"];
    assert_eq!(questions[0]["item"], json!(item), "step 2, the question");
    assert_eq!(
        questions[0]["answer"]["text"],
        json!("serde-saphyr"),
        "step 2, the agent reads the answer"
    );

    let task = home.new_ticket(&["task", "Renew the domain"]);

    assert_eq!(
        needs(&home, &gh, "step 3")["items"],
        json!([{ "reason": "looseTask", "id": task }]),
        "step 3, needs lists the loose task"
    );
    let moved = home.tikk(&["move", &task, "--parent", &plan]);
    assert_eq!(moved.exit_code, 0, "step 3, move: {}", moved.stderr);
    assert_eq!(
        needs(&home, &gh, "step 3")["items"],
        json!([]),
        "step 3, the moved task is not loose"
    );

    let claim = home.tikk_as("manager", &["claim", &slice, "--json"]);
    assert_eq!(claim.exit_code, 0, "step 4, claim: {}", claim.stderr);
    let claim_line = home.fact_lines().pop().expect("the claim is the last fact");
    let mut lease_ended = claim_line.clone();
    lease_ended["leaseEnd"] = json!("2020-01-01T04:00:00Z");
    let month = claim_line["at"].as_str().expect("a fact has a time")[..7].to_owned();
    home.append_fact_line(&format!("{month}.jsonl"), &lease_ended.to_string());

    assert_eq!(
        needs(&home, &gh, "step 4")["items"],
        json!([{
            "reason": "staleClaim",
            "id": slice,
            "holder": "manager",
            "leaseEnd": "2020-01-01T04:00:00.000Z",
        }]),
        "step 4, needs lists the stale claim"
    );
    let release = home.tikk(&["release", &slice, "--json"]);
    assert_eq!(release.exit_code, 0, "step 4, release: {}", release.stderr);
    assert_eq!(
        needs(&home, &gh, "step 4")["items"],
        json!([]),
        "step 4, the released slice is not listed"
    );

    let merged = home.slice_under(&plan, "Add ticket files", &[]);
    link_open_pr(&home, &gh, &merged, 7);
    merge_and_refresh(&home, &gh, 7, HEAD);
    let shown_pr = home.show_json(&merged)["pr"].clone();

    let listed = needs(&home, &gh, "step 5");

    assert_eq!(
        listed["items"],
        json!([{
            "reason": "mergedUnverified",
            "id": merged,
            "pr": shown_pr,
            "prCheckedAt": shown_pr["prCheckedAt"],
        }]),
        "step 5, needs lists the merged slice"
    );
    assert!(
        listed["items"][0]["prCheckedAt"].is_string(),
        "step 5, the item has prCheckedAt: {listed}"
    );
    audit_met(&home, &merged);
    assert_eq!(
        home.show_json(&merged)["derivedStatus"],
        json!("done"),
        "step 5, the audited slice is done"
    );

    assert_eq!(
        needs(&home, &gh, "end state"),
        json!({ "items": [], "problems": [] }),
        "end state, nothing waits on the user"
    );
}
