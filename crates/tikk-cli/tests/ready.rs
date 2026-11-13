mod support;

use std::time::Instant;

use serde_json::{Value, json};

use support::{Home, parse_json, run_git};

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

const ALPHABET: &str = "346789abcdefghijkmnpqrtwxyz";

fn bench_id(index: usize) -> String {
    let alphabet: Vec<char> = ALPHABET.chars().collect();
    let code: String = [index / 729, index / 27 % 27, index % 27, 0]
        .iter()
        .map(|digit| alphabet[*digit])
        .collect();

    format!("personal-{code}")
}

fn write_bench_tickets(home: &Home) -> Vec<String> {
    let folder = home.store().join("tickets/personal");
    std::fs::create_dir_all(&folder).expect("create the project folder");
    let mut slices = Vec::new();

    for index in 0..2_000 {
        let id = bench_id(index);
        let plan = bench_id(index / 100 * 100);
        let text = if index % 100 == 0 {
            format!("---\nkind: plan\ntitle: Plan {index}\nstatus: open\n---\nThe design.\n")
        } else {
            let blocked_by = if index % 100 == 1 {
                String::new()
            } else {
                bench_id(index - 1)
            };

            slices.push(id.clone());
            format!(
                "---\nkind: slice\ntitle: Slice {index}\nstatus: open\nparent: {plan}\nblockedBy: [{blocked_by}]\ncriteria:\n  - id: s1\n    check: cargo nextest run\n    expected: The tests pass.\n---\nThe body of slice {index}.\n"
            )
        };

        std::fs::write(folder.join(format!("{id}-ticket-{index}.md")), text)
            .expect("write a ticket");
    }

    slices
}

fn write_bench_facts(home: &Home, slices: &[String]) {
    let folder = home.store().join("facts/test");
    std::fs::create_dir_all(&folder).expect("create the machine folder");
    let mut text = String::new();

    for index in 0..100_000 {
        let ticket = &slices[index % slices.len()];
        let at = format!(
            "2026-01-{:02}T{:02}:{:02}:{:02}Z",
            1 + index / 86_400,
            index % 86_400 / 3_600,
            index % 3_600 / 60,
            index % 60
        );

        let line = if index % 2 == 0 {
            format!(
                "{{\"v\":1,\"kind\":\"claim\",\"ticket\":\"{ticket}\",\"at\":\"{at}\",\"agent\":\"manager-{index}\",\"session\":\"session-{index}\",\"sessionLog\":null,\"leaseEnd\":\"2026-01-05T00:00:00Z\"}}\n"
            )
        } else {
            format!(
                "{{\"v\":1,\"kind\":\"release\",\"ticket\":\"{ticket}\",\"at\":\"{at}\",\"agent\":null}}\n"
            )
        };

        text.push_str(&line);
    }

    std::fs::write(folder.join("2026-01.jsonl"), text).expect("write the fact file");
}

#[test]
#[expect(
    clippy::print_stderr,
    reason = "the test reports the measured time for the slice record"
)]
fn ready_json_of_two_thousand_tickets_and_a_hundred_thousand_facts_reports_its_time() {
    let home = Home::initialized();
    let slices = write_bench_tickets(&home);
    write_bench_facts(&home, &slices);

    let started = Instant::now();
    let run = home.tikk(&["ready", "--json"]);
    let elapsed = started.elapsed();

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    let queue = parse_json(&run.stdout);
    assert_eq!(queue["candidates"].as_array().map(Vec::len), Some(20));
    assert_eq!(queue["skipped"].as_array().map(Vec::len), Some(1_960));
    assert_eq!(queue["errors"], json!([]));
    eprintln!(
        "tikk ready --json with 2,000 tickets and 100,000 fact lines took {} ms",
        elapsed.as_millis()
    );
}
