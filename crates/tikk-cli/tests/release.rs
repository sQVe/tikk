mod support;

use serde_json::json;

use support::{Home, parse_json};

fn candidates(home: &Home, plan: &str) -> serde_json::Value {
    let run = home.tikk(&["ready", "--parent", plan, "--json"]);

    assert_eq!(run.exit_code, 0, "ready: {}", run.stderr);

    parse_json(&run.stdout)["candidates"].clone()
}

fn facts_month(home: &Home) -> String {
    let facts = home.fact_lines();
    let month = &facts[0]["at"].as_str().expect("a fact has a time")[..7];

    format!("{month}.jsonl")
}

#[test]
fn another_agent_cannot_release_a_live_claim_and_a_person_can() {
    let home = Home::initialized();
    let (plan, slice) = home.plan_and_slice();
    let claim = home.tikk_as("manager-1", &["claim", &slice]);
    assert_eq!(claim.exit_code, 0, "claim: {}", claim.stderr);

    let by_agent = home.tikk_as("manager-2", &["release", &slice, "--json"]);
    let held = home.show_json(&slice)["claim"]["agent"].clone();
    let by_person = home.tikk(&["release", &slice, "--json"]);

    assert_eq!(by_agent.exit_code, 1, "stdout: {}", by_agent.stdout);
    assert_eq!(
        parse_json(&by_agent.stderr)["error"]["code"],
        json!("claimed")
    );
    assert_eq!(held, json!("manager-1"));
    assert_eq!(by_person.exit_code, 0, "stderr: {}", by_person.stderr);
    let released = parse_json(&by_person.stdout);
    assert_eq!(released["id"], json!(slice));
    assert_eq!(released["released"], json!(true));
    assert_eq!(
        released["sync"]["committedPaths"],
        json!(["facts/test/".to_owned() + &facts_month(&home)]),
        "the release commits its fact"
    );
    assert_eq!(home.show_json(&slice)["claim"], json!(null));
    assert_eq!(candidates(&home, &plan)[0]["id"], json!(slice));
    let facts = home.fact_lines();
    assert_eq!(facts.len(), 2, "the claim and the release");
    assert_eq!(facts[1]["kind"], json!("release"));
    assert_eq!(facts[1]["agent"], json!(null));
}

#[test]
fn an_agent_releases_its_own_claim() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();
    let claim = home.tikk_as("manager", &["claim", &slice]);
    assert_eq!(claim.exit_code, 0, "claim: {}", claim.stderr);

    let run = home.tikk_as("manager", &["release", &slice]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(
        run.stdout.lines().next(),
        Some(format!("{slice}  released the claim of manager").as_str())
    );
    assert_eq!(home.show_json(&slice)["claim"], json!(null));
    assert_eq!(home.fact_lines()[1]["agent"], json!("manager"));
}

#[test]
fn release_of_a_slice_without_a_claim_writes_nothing() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();

    let run = home.tikk(&["release", &slice, "--json"]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    let released = parse_json(&run.stdout);
    assert_eq!(released["id"], json!(slice));
    assert_eq!(released["released"], json!(false));
    assert_eq!(released["sync"]["committed"], json!(false), "{released}");
    assert!(home.fact_lines().is_empty());
    assert_eq!(home.git(&["rev-list", "--count", "HEAD"]).trim(), "1");
}
