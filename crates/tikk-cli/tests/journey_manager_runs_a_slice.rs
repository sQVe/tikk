mod support;

use serde_json::json;

use support::{FakeGh, Home, parse_json, run_git};

#[test]
fn manager_runs_a_slice() {
    let home = Home::initialized();

    let plan_document = home.document(
        "plan.md",
        "---\nkind: plan\ntitle: Move to tikk\nstatus: open\ncriteria:\n  - id: p1\n    check: cargo nextest run\n    expected: The journeys pass.\n---\nThe design.\n",
    );
    let plan = home.new_ticket(&["--file", plan_document.to_str().expect("a UTF-8 path")]);
    let first_document = home.document(
        "first.md",
        &format!(
            "---\nkind: slice\ntitle: Add the store\nstatus: open\nparent: {plan}\ncriteria:\n  - id: s1\n    check: tikk init --json\n    expected: The store exists.\n---\n"
        ),
    );
    let first = home.new_ticket(&["--file", first_document.to_str().expect("a UTF-8 path")]);
    let second_document = home.document(
        "second.md",
        &format!(
            "---\nkind: slice\ntitle: Add ticket files\nstatus: open\nparent: {plan}\nblockedBy: [{first}]\ncriteria:\n  - id: s1\n    check: tikk ls --json\n    expected: The tickets are listed.\n---\n"
        ),
    );
    let second = home.new_ticket(&["--file", second_document.to_str().expect("a UTF-8 path")]);

    let show = home.tikk(&["show", &second, "--json"]);

    assert_eq!(show.exit_code, 0, "step 1, show: {}", show.stderr);
    let shown = parse_json(&show.stdout);
    assert_eq!(shown["blockedBy"], json!([first]), "step 1, blocker");
    assert_eq!(
        shown["criteria"],
        json!([{
            "id": "s1",
            "check": "tikk ls --json",
            "expected": "The tickets are listed.",
        }]),
        "step 1, criterion"
    );
    assert_eq!(shown["parent"], json!(plan), "step 1, parent");

    let ready = home.tikk(&["ready", "--parent", &plan, "--json"]);

    assert_eq!(ready.exit_code, 0, "step 2, ready: {}", ready.stderr);
    let queue = parse_json(&ready.stdout);
    assert_eq!(
        queue["candidates"][0]["id"],
        json!(first),
        "step 2, candidate"
    );
    assert_eq!(
        queue["candidates"].as_array().map(Vec::len),
        Some(1),
        "step 2, one candidate"
    );
    assert_eq!(queue["skipped"][0]["id"], json!(second), "step 2, skipped");
    assert_eq!(
        queue["skipped"][0]["holds"],
        json!([{ "reason": "blockedBy", "blocker": first, "via": null, "state": "open" }]),
        "step 2, the first slice blocks the second"
    );

    let claim = home.tikk_as("manager", &["claim", &first, "--json"]);

    assert_eq!(claim.exit_code, 0, "step 3, claim: {}", claim.stderr);
    let claimed = parse_json(&claim.stdout);
    assert_eq!(
        claimed["claim"]["agent"],
        json!("manager"),
        "step 3, holder"
    );
    let claimed_end = claimed["claim"]["leaseEnd"].clone();
    assert!(claimed_end.is_string(), "step 3, leaseEnd: {claimed}");
    let other = home.tikk_as("other-manager", &["claim", &first, "--json"]);
    assert_eq!(other.exit_code, 1, "step 3, a second agent's claim");
    assert_eq!(
        parse_json(&other.stderr)["error"]["code"],
        json!("claimed"),
        "step 3, a second agent's claim"
    );

    let instruction_document = home.document(
        "instruction.md",
        &format!("---\nkind: instruction\ntitle: Write the store\nparent: {first}\n---\n"),
    );
    let new = home.tikk_as(
        "manager",
        &[
            "new",
            "--file",
            instruction_document.to_str().expect("a UTF-8 path"),
            "--json",
        ],
    );
    assert_eq!(new.exit_code, 0, "step 4, new: {}", new.stderr);
    let instruction = parse_json(&new.stdout)["id"].clone();
    let instruction = instruction.as_str().expect("new prints the ID");
    let created_end = home.show_json(&first)["claim"]["leaseEnd"].clone();

    let done = home.tikk_as("manager", &["done", instruction, "--json"]);

    assert_eq!(done.exit_code, 0, "step 4, done: {}", done.stderr);
    let slice = home.show_json(&first);
    assert_eq!(
        slice["children"][0]["id"],
        json!(instruction),
        "step 4, the instruction"
    );
    assert_eq!(
        slice["children"][0]["status"],
        json!("done"),
        "step 4, the instruction is done"
    );
    let done_end = slice["claim"]["leaseEnd"].clone();
    assert!(
        created_end.as_str() > claimed_end.as_str(),
        "step 4, new moves leaseEnd from {claimed_end} to {created_end}"
    );
    assert!(
        done_end.as_str() > created_end.as_str(),
        "step 4, done moves leaseEnd from {created_end} to {done_end}"
    );

    let gh = FakeGh::new();
    let head = "1111111111111111111111111111111111111111";
    gh.open_pr("owner/app", 12, head);

    let link = home.tikk_with_gh(
        &gh,
        Some("manager"),
        &[
            "pr",
            "link",
            &first,
            "https://github.com/owner/app/pull/12",
            "--json",
        ],
    );

    assert_eq!(link.exit_code, 0, "step 5, pr link: {}", link.stderr);
    let slice = home.show_json(&first);
    let pr = &slice["pr"];
    assert_eq!(pr["number"], json!(12), "step 5, the PR number");
    assert_eq!(pr["state"], json!("open"), "step 5, the PR state");
    assert!(
        pr["prCheckedAt"].is_string(),
        "step 5, prCheckedAt: {slice}"
    );
    let ready = home.tikk(&["ready", "--parent", &plan, "--json"]);
    assert_eq!(ready.exit_code, 0, "step 5, ready: {}", ready.stderr);
    let queue = parse_json(&ready.stdout);
    let offered = queue["candidates"]
        .as_array()
        .expect("ready lists candidates")
        .iter()
        .find(|row| row["id"] == json!(second))
        .unwrap_or_else(|| panic!("step 5, ready offers the second slice: {queue}"));
    assert_eq!(
        offered["stackParent"]["slice"],
        json!(first),
        "step 5, the stack parent"
    );
    assert_eq!(
        offered["stackParent"]["number"],
        json!(12),
        "step 5, the stack parent's PR"
    );
    assert_eq!(
        offered["stackParent"]["prCheckedAt"], pr["prCheckedAt"],
        "step 5, the stack parent's check time"
    );

    assert_eq!(
        slice["claim"]["agent"],
        json!("manager"),
        "step 5, the manager holds the first slice"
    );
    assert!(
        slice["claim"]["leaseEnd"].as_str() > done_end.as_str(),
        "step 5, pr link moves leaseEnd from {done_end}"
    );

    run_git(&home.work(), &["init", "--quiet"]);
    run_git(
        &home.work(),
        &["remote", "add", "origin", "git@github.com:owner/app.git"],
    );
    let verdicts = home.document(
        "verdicts.json",
        &json!([{ "criterion": "s1", "verdict": "met", "evidence": "tikk init --json created the store." }])
            .to_string(),
    );
    let hash = slice["hash"].as_str().expect("show prints the hash");

    let audit = home.tikk_as(
        "manager",
        &[
            "audit",
            &first,
            "--hash",
            hash,
            "--head",
            head,
            "--file",
            verdicts.to_str().expect("a UTF-8 path"),
            "--json",
        ],
    );

    assert_eq!(audit.exit_code, 0, "step 6, audit: {}", audit.stderr);
    let slice = home.show_json(&first);
    assert_eq!(
        slice["audit"]["repository"],
        json!("owner/app"),
        "step 6, the repository"
    );
    assert_eq!(slice["audit"]["head"], json!(head), "step 6, the head");
    assert_eq!(
        slice["audit"]["counts"],
        json!(true),
        "step 6, the audit counts: {slice}"
    );
    assert_eq!(
        slice["derivedStatus"],
        json!("open"),
        "step 6, open until the merge"
    );

    gh.merged_pr(
        "owner/app",
        12,
        support::TRUNK,
        head,
        "2222222222222222222222222222222222222222",
    );
    let refresh = home.tikk_with_gh(&gh, Some("manager"), &["pr", "refresh", "--json"]);

    assert_eq!(
        refresh.exit_code, 0,
        "step 7, pr refresh: {}",
        refresh.stderr
    );
    let slice = home.show_json(&first);
    assert_eq!(
        slice["pr"]["inTrunk"],
        json!(true),
        "step 7, the PR is in trunk"
    );
    assert_eq!(slice["status"], json!("open"), "step 7, the stored status");
    assert_eq!(
        slice["derivedStatus"],
        json!("done"),
        "step 7, done: {slice}"
    );

    let calls = gh.calls();
    let needs = home.tikk_with_gh(&gh, None, &["needs", "--json"]);

    assert_eq!(needs.exit_code, 0, "step 8, needs: {}", needs.stderr);
    let items = parse_json(&needs.stdout)["items"].clone();
    let for_first: Vec<&serde_json::Value> = items
        .as_array()
        .expect("needs lists items")
        .iter()
        .filter(|item| item["id"] == json!(first))
        .collect();
    assert_eq!(
        for_first,
        Vec::<&serde_json::Value>::new(),
        "step 8, no item for the first slice: {items}"
    );
    assert_eq!(gh.calls(), calls, "step 8, needs runs no gh");

    let ready = home.tikk(&["ready", "--parent", &plan, "--json"]);
    assert_eq!(ready.exit_code, 0, "end state, ready: {}", ready.stderr);
    let queue = parse_json(&ready.stdout);
    assert_eq!(
        queue["candidates"],
        json!([{
            "id": second,
            "title": "Add ticket files",
            "kind": "slice",
            "status": "open",
            "parent": plan,
            "stackParent": null,
        }]),
        "end state, ready offers only the second slice, with no stack parent"
    );
    assert_eq!(queue["skipped"], json!([]), "end state, nothing is skipped");
    assert_eq!(
        home.show_json(&second)["blockedBy"],
        json!([first]),
        "end state, the second slice still names its blocker"
    );
}
