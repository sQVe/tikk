mod support;

use serde_json::{Value, json};

use support::audit::{HEAD, audit_met, link_open_pr, merge_and_refresh};
use support::{FakeGh, Home, parse_json, run_git};

fn ready(home: &Home, arguments: &[&str]) -> Value {
    let mut all = vec!["ready", "--json"];

    all.extend_from_slice(arguments);

    let run = home.tikk(&all);

    assert_eq!(run.exit_code, 0, "ready {arguments:?}: {}", run.stderr);

    parse_json(&run.stdout)
}

fn ids(rows: &Value) -> Vec<String> {
    rows.as_array()
        .expect("a list of rows")
        .iter()
        .map(|row| row["id"].as_str().expect("a row has an ID").to_owned())
        .collect()
}

#[test]
fn ready_parent_returns_the_unblocked_slices_by_rank_and_names_each_blocker() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let second = home.slice_under(&plan, "Add ticket files", &[]);
    let first = home.slice_under(&plan, "Add the store", &[]);
    let blocked = home.slice_under(&plan, "Add claims", &[&first]);
    let rank = home.tikk(&["rank", &first, "--first"]);
    assert_eq!(rank.exit_code, 0, "rank: {}", rank.stderr);

    let queue = ready(&home, &["--parent", &plan]);

    assert_eq!(ids(&queue["candidates"]), [first.clone(), second]);
    assert_eq!(ids(&queue["skipped"]), [blocked]);
    assert_eq!(
        queue["skipped"][0]["holds"],
        json!([{ "reason": "blockedBy", "blocker": first, "via": null, "state": "open" }])
    );
    assert_eq!(queue["errors"], json!([]));
}

#[test]
fn ready_parent_skips_the_slices_of_a_blocked_plan_and_names_the_plan() {
    let home = Home::initialized();
    let task = home.new_ticket(&["task", "Decide the lease length"]);
    let plan_document = home.document(
        "plan.md",
        &format!("---\nkind: plan\ntitle: Move to tikk\nblockedBy: [{task}]\n---\n"),
    );
    let plan = home.new_ticket(&["--file", plan_document.to_str().expect("a UTF-8 path")]);
    let slice = home.slice_under(&plan, "Add the store", &[]);

    let held = ready(&home, &["--parent", &plan]);
    let done = home.tikk(&["done", &task]);
    let freed = ready(&home, &["--parent", &plan]);

    assert_eq!(held["candidates"], json!([]));
    assert_eq!(ids(&held["skipped"]), std::slice::from_ref(&slice));
    assert_eq!(
        held["skipped"][0]["holds"],
        json!([{ "reason": "blockedBy", "blocker": task, "via": plan, "state": "open" }])
    );
    assert_eq!(done.exit_code, 0, "done: {}", done.stderr);
    assert_eq!(ids(&freed["candidates"]), [slice]);
}

#[test]
fn ready_parent_skips_the_slices_of_a_draft_or_canceled_plan_and_names_the_plan() {
    let home = Home::initialized();
    let draft_document = home.document(
        "draft-plan.md",
        "---\nkind: plan\ntitle: Not agreed\nstatus: draft\n---\n",
    );
    let draft_plan = home.new_ticket(&["--file", draft_document.to_str().expect("a UTF-8 path")]);
    let canceled_plan = home.new_ticket(&["plan", "Dropped"]);
    let open_plan = home.new_ticket(&["plan", "Agreed"]);
    let under_draft = home.slice_under(&draft_plan, "Wait for the plan", &[]);
    let under_canceled = home.slice_under(&canceled_plan, "Never start", &[]);
    let under_open = home.slice_under(&open_plan, "Start", &[]);
    let cancel = home.tikk(&["cancel", &canceled_plan, "--reason", "Out of scope"]);
    assert_eq!(cancel.exit_code, 0, "cancel: {}", cancel.stderr);

    let cases = [
        (&draft_plan, &under_draft, "draft"),
        (&canceled_plan, &under_canceled, "canceled"),
    ];

    for (plan, slice, state) in cases {
        let queue = ready(&home, &["--parent", plan]);

        assert_eq!(queue["candidates"], json!([]), "case {state}");
        assert_eq!(
            ids(&queue["skipped"]),
            std::slice::from_ref(slice),
            "case {state}"
        );
        assert_eq!(
            queue["skipped"][0]["holds"],
            json!([{ "reason": "parent", "parent": plan, "state": state }]),
            "case {state}"
        );
    }
    let open = ready(&home, &["--parent", &open_plan]);
    assert_eq!(ids(&open["candidates"]), [under_open]);
}

#[test]
fn ready_skips_a_claimed_draft_or_wrongly_blocked_slice_and_omits_a_canceled_one() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let claimed = home.slice_under(&plan, "Claimed", &[]);
    let missing = home.slice_under(&plan, "Missing", &[]);
    let canceled = home.slice_under(&plan, "Canceled", &[]);
    let draft = home.new_ticket(&["slice", "Draft", "--parent", &plan]);
    let claim = home.tikk_as("manager", &["claim", &claimed, "--json"]);
    assert_eq!(claim.exit_code, 0, "claim: {}", claim.stderr);
    let cancel = home.tikk(&["cancel", &canceled, "--reason", "Dropped"]);
    assert_eq!(cancel.exit_code, 0, "cancel: {}", cancel.stderr);
    let draft_path = home.show_json(&draft)["path"]
        .as_str()
        .expect("show prints the path")
        .to_owned();
    std::fs::write(
        &draft_path,
        format!("---\nkind: slice\ntitle: Draft\nstatus: draft\nparent: {plan}\n---\n"),
    )
    .expect("make the slice a draft");
    let missing_path = home.show_json(&missing)["path"]
        .as_str()
        .expect("show prints the path")
        .to_owned();
    std::fs::write(
        &missing_path,
        format!(
            "---\nkind: slice\ntitle: Missing\nparent: {plan}\nblockedBy: [personal-zzzz]\n---\n"
        ),
    )
    .expect("block the slice by a ticket that does not exist");

    let queue = ready(&home, &["--parent", &plan]);

    assert_eq!(queue["candidates"], json!([]));
    let mut skipped: Vec<(String, Value)> = queue["skipped"]
        .as_array()
        .expect("a list of rows")
        .iter()
        .map(|row| {
            (
                row["id"].as_str().expect("an ID").to_owned(),
                row["holds"].clone(),
            )
        })
        .collect();
    skipped.sort_by(|left, right| left.0.cmp(&right.0));
    let mut expected = vec![
        (
            claimed,
            json!([{
                "reason": "claimed",
                "claim": parse_json(&claim.stdout)["claim"],
            }]),
        ),
        (
            missing,
            json!([{ "reason": "blockedBy", "blocker": "personal-zzzz", "via": null, "state": "missing" }]),
        ),
        (draft, json!([{ "reason": "draft" }])),
    ];
    expected.sort_by(|left, right| left.0.cmp(&right.0));
    assert_eq!(skipped, expected);
}

#[test]
fn ready_in_a_repository_lists_its_project_and_project_lists_another() {
    let home = Home::initialized();
    run_git(&home.work(), &["init", "--quiet"]);
    run_git(
        &home.work(),
        &["remote", "add", "origin", "git@github.com:owner/tikk.git"],
    );
    let tikk_plan = home.new_ticket(&["plan", "Ship tikk", "--project", "tikk"]);
    let tikk_slice = home.slice_under(&tikk_plan, "Add claims", &[]);
    let personal_plan = home.new_ticket(&["plan", "Move house", "--project", "personal"]);
    let personal_slice = home.slice_under(&personal_plan, "Pack", &[]);

    let here = ready(&home, &[]);
    let other = ready(&home, &["--project", "personal"]);

    assert_eq!(ids(&here["candidates"]), [tikk_slice]);
    assert_eq!(ids(&other["candidates"]), [personal_slice]);
}

#[test]
fn ready_reports_a_fact_line_that_does_not_parse_and_lists_the_slices() {
    let home = Home::initialized();
    let (plan, slice) = home.plan_and_slice();
    home.append_fact_line("2026-11.jsonl", "{\"v\":1,");

    let queue = ready(&home, &["--parent", &plan]);

    assert_eq!(ids(&queue["candidates"]), [slice]);
    let errors = queue["errors"].as_array().expect("a list of errors");
    assert_eq!(errors.len(), 1);
    assert_eq!(
        errors[0]["path"],
        json!(
            home.store()
                .join("facts/test/2026-11.jsonl")
                .to_str()
                .expect("a UTF-8 path")
        )
    );
    assert_eq!(errors[0]["line"], json!(1));
}

#[test]
fn ready_parent_refuses_a_ticket_that_is_not_a_plan() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();

    let run = home.tikk(&["ready", "--parent", &slice, "--json"]);

    assert_eq!(run.exit_code, 1);
    assert_eq!(parse_json(&run.stderr)["error"]["code"], json!("wrongKind"));
}

#[test]
fn ready_without_json_prints_rows_and_the_holds_of_skipped_slices() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let first = home.slice_under(&plan, "Add the store", &[]);
    let second = home.slice_under(&plan, "Add claims", &[&first]);

    let run = home.tikk(&["ready", "--parent", &plan]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(
        run.stdout,
        format!(
            "{first}  slice  open  {plan}  Add the store\nskipped: {second}  slice  open  {plan}  Add claims\n  blocked by {first} (open)\n"
        )
    );
}

#[test]
fn ready_offers_a_slice_blocked_by_a_slice_with_an_open_pr_and_names_that_pr() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let first = home.slice_under(&plan, "Add the store", &[]);
    let second = home.slice_under(&plan, "Add ticket files", &[&first]);
    link_open_pr(&home, &gh, &first, 7);
    let checked_at = home.show_json(&first)["pr"]["prCheckedAt"].clone();

    let queue = ready(&home, &["--parent", &plan]);

    let candidate = |id: &str| {
        queue["candidates"]
            .as_array()
            .expect("a list of candidates")
            .iter()
            .find(|row| row["id"] == json!(id))
            .cloned()
            .unwrap_or_else(|| panic!("{id} is a candidate: {queue}"))
    };
    assert_eq!(candidate(&first)["stackParent"], json!(null));
    assert_eq!(
        candidate(&second)["stackParent"],
        json!({
            "slice": first,
            "repository": "owner/app",
            "number": 7,
            "url": "https://github.com/owner/app/pull/7",
            "head": HEAD,
            "prCheckedAt": checked_at,
        })
    );
    let text = home.tikk(&["ready", "--parent", &plan]);
    assert!(
        text.stdout.contains(&format!(
            "  stacks on https://github.com/owner/app/pull/7 of {first} at {HEAD}, checked "
        )),
        "{}",
        text.stdout
    );
}

#[test]
fn ready_skips_a_slice_blocked_by_a_task_that_waits_on_a_slice_with_an_open_pr() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let first = home.slice_under(&plan, "Add the store", &[]);
    let task = home.new_ticket(&["task", "Decide the lease length", "--parent", &plan]);
    let block = home.tikk(&["block", &task, &first]);
    assert_eq!(block.exit_code, 0, "block: {}", block.stderr);
    let second = home.slice_under(&plan, "Add ticket files", &[&task]);
    link_open_pr(&home, &gh, &first, 7);

    let queue = ready(&home, &["--parent", &plan]);

    assert_eq!(ids(&queue["candidates"]), [first]);
    assert_eq!(ids(&queue["skipped"]), [second]);
    assert_eq!(
        queue["skipped"][0]["holds"],
        json!([{ "reason": "blockedBy", "blocker": task, "via": null, "state": "open" }])
    );
}

#[test]
fn ready_skips_a_claimed_slice_with_a_shared_id_with_id_shared_and_no_claim() {
    let home = Home::initialized();
    let (plan, slice) = home.plan_and_slice();
    let claim = home.tikk_as("manager", &["claim", &slice]);
    assert_eq!(claim.exit_code, 0, "claim: {}", claim.stderr);
    let paths = home.share_id(&slice);

    let run = home.tikk(&["ready", "--parent", &plan, "--json"]);

    assert_eq!(run.exit_code, 0, "{}", run.stderr);
    let queue = parse_json(&run.stdout);
    assert_eq!(queue["candidates"], json!([]), "{queue}");
    let skipped = queue["skipped"].as_array().expect("ready lists skipped");
    assert_eq!(skipped.len(), 2, "both files of the ID: {queue}");
    for row in skipped {
        assert_eq!(row["id"], json!(slice));
        assert_eq!(
            row["holds"],
            json!([{ "reason": "idShared", "paths": paths }]),
            "{row}"
        );
    }
    let text = home.tikk(&["ready", "--parent", &plan]).stdout;
    assert!(
        text.contains(&format!("\n  idShared: {}\n", paths.join("  "))),
        "{text}"
    );
}

#[test]
fn ready_holds_a_merged_unverified_slice_and_its_blocked_slice_until_the_audit_counts() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let first = home.slice_under(&plan, "Add the store", &[]);
    let second = home.slice_under(&plan, "Add ticket files", &[&first]);
    link_open_pr(&home, &gh, &first, 7);
    merge_and_refresh(&home, &gh, 7, HEAD);

    let unverified = ready(&home, &["--parent", &plan]);

    let holds = |id: &str| {
        unverified["skipped"]
            .as_array()
            .expect("a list of skipped slices")
            .iter()
            .find(|row| row["id"] == json!(id))
            .map(|row| row["holds"].clone())
            .unwrap_or_else(|| panic!("{id} is skipped: {unverified}"))
    };
    assert_eq!(unverified["candidates"], json!([]), "{unverified}");
    assert_eq!(holds(&first), json!([{ "reason": "mergedUnverified" }]));
    assert_eq!(
        holds(&second),
        json!([{ "reason": "blockedBy", "blocker": first, "via": null, "state": "mergedUnverified" }])
    );

    audit_met(&home, &first);
    let done = ready(&home, &["--parent", &plan]);

    assert_eq!(ids(&done["candidates"]), [second]);
    assert_eq!(done["candidates"][0]["stackParent"], json!(null));
    assert_eq!(done["skipped"], json!([]), "{done}");
}

#[test]
fn ready_offers_the_slices_of_a_plan_blocked_by_a_done_plan() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (first_plan, first) = home.plan_and_slice();
    let plan_document = home.document(
        "plan.md",
        &format!("---\nkind: plan\ntitle: Add claims\nblockedBy: [{first_plan}]\n---\n"),
    );
    let second_plan = home.new_ticket(&["--file", plan_document.to_str().expect("a UTF-8 path")]);
    let second = home.slice_under(&second_plan, "Add the lease", &[]);
    link_open_pr(&home, &gh, &first, 7);
    merge_and_refresh(&home, &gh, 7, HEAD);

    let before = ready(&home, &["--parent", &second_plan]);

    assert_eq!(
        before["skipped"][0]["holds"],
        json!([{ "reason": "blockedBy", "blocker": first_plan, "via": second_plan, "state": "open" }])
    );

    audit_met(&home, &first);
    let after = ready(&home, &["--parent", &second_plan]);

    assert_eq!(ids(&after["candidates"]), [second]);
}
