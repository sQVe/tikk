mod support;

use std::process::Stdio;

use serde_json::json;

use support::{Home, Remote, finish, parse_json};

#[test]
fn of_two_agents_that_claim_one_slice_at_once_exactly_one_wins() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();
    let children: Vec<_> = ["manager-1", "manager-2"]
        .iter()
        .map(|agent| {
            home.command(&["claim", &slice, "--json"])
                .env("TIKK_AGENT", agent)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("start the tikk binary")
        })
        .collect();
    let runs: Vec<_> = children
        .into_iter()
        .map(|child| finish(child.wait_with_output().expect("wait for tikk")))
        .collect();

    let mut exit_codes: Vec<i32> = runs.iter().map(|run| run.exit_code).collect();
    exit_codes.sort_unstable();
    assert_eq!(exit_codes, [0, 1], "one claim wins and one is refused");
    let refused = runs
        .iter()
        .find(|run| run.exit_code == 1)
        .expect("one claim is refused");
    assert_eq!(
        parse_json(&refused.stderr)["error"]["code"],
        json!("claimed")
    );
    let claims: Vec<_> = home
        .fact_lines()
        .into_iter()
        .filter(|fact| fact["kind"] == json!("claim"))
        .collect();
    assert_eq!(claims.len(), 1, "the fact file holds one claim line");
}

fn claim_of(home: &Home, slice: &str) -> serde_json::Value {
    home.show_json(slice)["claim"].clone()
}

#[test]
fn claim_returns_the_claim_with_its_session_and_lease_end() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();
    let mut command = home.command(&["claim", &slice, "--json"]);
    command
        .env("TIKK_AGENT", "manager")
        .env("TIKK_SESSION", "session-1")
        .env("TIKK_SESSION_LOG", "/logs/session-1.jsonl");

    let run = finish(command.output().expect("start the tikk binary"));

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    let claimed = parse_json(&run.stdout);
    assert_eq!(claimed["id"], json!(slice));
    assert_eq!(claimed["claim"]["agent"], json!("manager"));
    assert_eq!(claimed["claim"]["session"], json!("session-1"));
    assert_eq!(
        claimed["claim"]["sessionLog"],
        json!("/logs/session-1.jsonl")
    );
    assert_eq!(claimed["claim"]["state"], json!("claimed"));
    assert_eq!(claim_of(&home, &slice), claimed["claim"]);
    let facts = home.fact_lines();
    assert_eq!(facts.len(), 1);
    assert_eq!(facts[0]["v"], json!(1));
    assert_eq!(facts[0]["kind"], json!("claim"));
    assert_eq!(facts[0]["ticket"], json!(slice));
    assert_eq!(facts[0]["leaseEnd"], claimed["claim"]["leaseEnd"]);
}

#[test]
fn a_second_claim_by_the_same_agent_moves_the_lease_end_forward() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();
    let first = home.tikk_as("manager", &["claim", &slice, "--json"]);
    assert_eq!(first.exit_code, 0, "first claim: {}", first.stderr);

    let second = home.tikk_as("manager", &["claim", &slice, "--json"]);

    assert_eq!(second.exit_code, 0, "second claim: {}", second.stderr);
    let first_end = parse_json(&first.stdout)["claim"]["leaseEnd"].clone();
    let second_end = parse_json(&second.stdout)["claim"]["leaseEnd"].clone();
    assert!(
        second_end.as_str() > first_end.as_str(),
        "{second_end} is after {first_end}"
    );
    assert_eq!(claim_of(&home, &slice)["leaseEnd"], second_end);
}

#[test]
fn claim_without_tikk_agent_exits_with_1_and_names_the_variable() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();

    let unset = home.tikk(&["claim", &slice, "--json"]);
    let empty = home.tikk_as("", &["claim", &slice, "--json"]);

    for (name, run) in [("unset", unset), ("empty", empty)] {
        assert_eq!(run.exit_code, 1, "case {name}");
        let error = &parse_json(&run.stderr)["error"];
        assert_eq!(error["code"], json!("noTikkAgent"), "case {name}");
        let message = error["message"].as_str().expect("the error has a message");
        assert!(message.contains("TIKK_AGENT"), "case {name}: {message}");
    }
    assert!(home.fact_lines().is_empty());
}

#[test]
fn claim_names_the_field_that_fails_strict_validation() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let no_criteria = home.new_ticket(&["slice", "Add the store", "--parent", &plan]);
    let draft_document = home.document(
        "draft.md",
        &format!(
            "---\nkind: slice\ntitle: Draft\nstatus: draft\nparent: {plan}\ncriteria:\n  - id: s1\n    check: c\n    expected: e\n---\n"
        ),
    );
    let draft = home.new_ticket(&["--file", draft_document.to_str().expect("a UTF-8 path")]);

    for (slice, field) in [(&no_criteria, "criteria"), (&draft, "status")] {
        let run = home.tikk_as("manager", &["claim", slice, "--json"]);

        assert_eq!(run.exit_code, 1, "case {field}");
        let error = &parse_json(&run.stderr)["error"];
        assert_eq!(error["code"], json!("invalidTicket"), "case {field}");
        assert_eq!(error["field"], json!(field), "case {field}");
    }
    assert!(home.fact_lines().is_empty());
}

#[test]
fn claim_refuses_a_ticket_that_is_not_a_slice() {
    let home = Home::initialized();
    let task = home.new_ticket(&["task", "Renew the domain"]);

    let run = home.tikk_as("manager", &["claim", &task, "--json"]);

    assert_eq!(run.exit_code, 1);
    assert_eq!(parse_json(&run.stderr)["error"]["code"], json!("wrongKind"));
}

#[test]
fn after_the_lease_ends_show_reports_a_stale_claim_and_another_agent_claims() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();
    home.append_fact_line(
        "2020-01.jsonl",
        &format!(
            "{{\"v\":1,\"kind\":\"claim\",\"ticket\":\"{slice}\",\"at\":\"2020-01-01T00:00:00Z\",\"agent\":\"manager-1\",\"session\":null,\"sessionLog\":null,\"leaseEnd\":\"2020-01-01T04:00:00Z\"}}"
        ),
    );

    let stale = claim_of(&home, &slice);
    let run = home.tikk_as("manager-2", &["claim", &slice, "--json"]);

    assert_eq!(stale["state"], json!("staleClaim"));
    assert_eq!(stale["agent"], json!("manager-1"));
    assert_eq!(stale["leaseEnd"], json!("2020-01-01T04:00:00.000Z"));
    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    let live = claim_of(&home, &slice);
    assert_eq!(live["agent"], json!("manager-2"));
    assert_eq!(live["state"], json!("claimed"));
}

#[test]
fn new_and_cancel_on_the_slice_of_another_agent_exit_with_claimed_and_write_nothing() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();
    let instruction = home.new_ticket(&["instruction", "Write the lock", "--parent", &slice]);
    let claim = home.tikk_as("manager-1", &["claim", &slice]);
    assert_eq!(claim.exit_code, 0, "claim: {}", claim.stderr);
    let files = home.ticket_files();
    let before = home.show_json(&instruction)["hash"].clone();

    let new = home.tikk_as(
        "manager-2",
        &[
            "new",
            "instruction",
            "Write more",
            "--parent",
            &slice,
            "--json",
        ],
    );
    let cancel = home.tikk_as(
        "manager-2",
        &["cancel", &instruction, "--reason", "Taken", "--json"],
    );

    for (name, run) in [("new", new), ("cancel", cancel)] {
        assert_eq!(run.exit_code, 1, "case {name}");
        assert_eq!(
            parse_json(&run.stderr)["error"]["code"],
            json!("claimed"),
            "case {name}"
        );
    }
    assert_eq!(home.ticket_files(), files);
    assert_eq!(home.show_json(&instruction)["hash"], before);
    assert_eq!(home.fact_lines().len(), 1, "only the claim line");
}

#[test]
fn new_of_an_instruction_by_the_holder_moves_the_lease_end_forward() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();
    let claim = home.tikk_as("manager", &["claim", &slice, "--json"]);
    assert_eq!(claim.exit_code, 0, "claim: {}", claim.stderr);
    let claimed_end = parse_json(&claim.stdout)["claim"]["leaseEnd"].clone();

    let run = home.tikk_as(
        "manager",
        &["new", "instruction", "Write the lock", "--parent", &slice],
    );

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    let renewed_end = claim_of(&home, &slice)["leaseEnd"].clone();
    assert!(
        renewed_end.as_str() > claimed_end.as_str(),
        "{renewed_end} is after {claimed_end}"
    );
}

#[test]
fn claim_without_json_prints_the_holder_and_lease_end() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();

    let run = home.tikk_as("manager", &["claim", &slice]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    let lease_end = claim_of(&home, &slice)["leaseEnd"].clone();
    let lines: Vec<&str> = run.stdout.lines().collect();
    assert_eq!(
        lines[0],
        format!(
            "{slice}  claimed by manager until {}",
            lease_end.as_str().expect("a lease end")
        )
    );
    assert_eq!(
        lines[1], "committed: 1  fetched: no  merged: no  pushed: no",
        "the sync line follows: {}",
        run.stdout
    );
}

#[test]
fn a_claim_on_one_store_refuses_another_agent_on_a_second_store_without_a_sync() {
    let remote = Remote::new();
    let laptop = Home::on_remote(&remote, "laptop");
    let desktop = Home::on_remote(&remote, "desktop");
    let (_plan, slice) = laptop.plan_and_slice();
    laptop.settle_files();

    let first = laptop.tikk_as("manager-1", &["claim", &slice, "--json"]);
    let second = desktop.tikk_as("manager-2", &["claim", &slice, "--json"]);

    assert_eq!(first.exit_code, 0, "first claim: {}", first.stderr);
    assert_eq!(second.exit_code, 1, "second claim: {}", second.stdout);
    assert_eq!(
        parse_json(&second.stderr)["error"]["code"],
        json!("claimed")
    );
}

#[test]
fn after_a_release_on_one_store_another_agent_claims_on_a_second_store() {
    let remote = Remote::new();
    let laptop = Home::on_remote(&remote, "laptop");
    let desktop = Home::on_remote(&remote, "desktop");
    let (_plan, slice) = laptop.plan_and_slice();
    laptop.settle_files();
    let first = laptop.tikk_as("manager-1", &["claim", &slice, "--json"]);
    assert_eq!(first.exit_code, 0, "first claim: {}", first.stderr);

    let release = laptop.tikk_as("manager-1", &["release", &slice, "--json"]);
    let second = desktop.tikk_as("manager-2", &["claim", &slice, "--json"]);

    assert_eq!(release.exit_code, 0, "release: {}", release.stderr);
    assert_eq!(second.exit_code, 0, "second claim: {}", second.stderr);
    assert_eq!(
        parse_json(&second.stdout)["claim"]["agent"],
        json!("manager-2")
    );
}

#[test]
fn a_merge_conflict_during_the_claim_is_named_in_sync_and_the_claim_exits_with_0() {
    let remote = Remote::new();
    let laptop = Home::on_remote(&remote, "laptop");
    let desktop = Home::on_remote(&remote, "desktop");
    let (plan, slice) = laptop.plan_and_slice();
    laptop.settle_files();
    laptop.sync_json();
    desktop.sync_json();
    let plan_file = |home: &Home| {
        std::path::PathBuf::from(
            home.show_json(&plan)["path"]
                .as_str()
                .expect("show prints the path"),
        )
    };
    std::fs::write(
        plan_file(&desktop),
        "---\nkind: plan\ntitle: Move to tikk this year\n---\n",
    )
    .expect("edit the plan on the desktop");
    desktop.settle_files();
    desktop.sync_json();
    let local_text = "---\nkind: plan\ntitle: Move to tikk next week\n---\n";
    std::fs::write(plan_file(&laptop), local_text).expect("edit the plan on the laptop");
    laptop.git(&[
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@localhost",
        "commit",
        "--quiet",
        "--all",
        "--message",
        "Edit the plan",
    ]);

    let run = laptop.tikk_as("manager", &["claim", &slice, "--json"]);

    assert_eq!(run.exit_code, 0, "{}", run.stderr);
    let sync = &parse_json(&run.stdout)["sync"];
    let relative_plan = plan_file(&laptop)
        .strip_prefix(laptop.store())
        .expect("inside the store")
        .to_str()
        .expect("a UTF-8 path")
        .to_owned();
    assert_eq!(sync["merged"], json!(false), "{sync}");
    assert_eq!(sync["pushed"], json!(false), "{sync}");
    assert_eq!(sync["problems"][0]["step"], json!("merge"), "{sync}");
    assert_eq!(
        sync["problems"][0]["files"],
        json!([relative_plan]),
        "{sync}"
    );
    assert!(!laptop.store().join(".git/MERGE_HEAD").exists());
    assert_eq!(
        std::fs::read_to_string(plan_file(&laptop)).expect("read the plan"),
        local_text
    );
    assert_eq!(claim_of(&laptop, &slice)["agent"], json!("manager"));
}
