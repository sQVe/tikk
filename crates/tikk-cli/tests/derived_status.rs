mod support;

use serde_json::{Value, json};

use support::audit::{
    HEAD, NEW_HEAD, REPOSITORY, audit, hash_of, linked_slice, merge_and_refresh, met, verdicts,
};
use support::{FakeGh, Home, parse_json};

#[test]
fn an_audit_that_meets_every_criterion_makes_the_merged_slice_done() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (_plan, slice) = linked_slice(&home, &gh);
    let file = verdicts(&home, &json!([met("s1")]));

    let run = audit(&home, None, &slice, HEAD, &file);

    assert_eq!(run.exit_code, 0, "audit: {}", run.stderr);
    merge_and_refresh(&home, &gh, 7, HEAD);
    let shown = home.show_json(&slice);
    assert_eq!(shown["status"], json!("open"), "{shown}");
    assert_eq!(shown["derivedStatus"], json!("done"), "{shown}");
    assert_eq!(shown["audit"]["counts"], json!(true), "{shown}");
    assert_eq!(shown["audit"]["reasons"], json!([]), "{shown}");
}

#[test]
fn a_merged_slice_with_no_audit_is_merged_unverified() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (_plan, slice) = linked_slice(&home, &gh);

    merge_and_refresh(&home, &gh, 7, HEAD);

    let shown = home.show_json(&slice);
    assert_eq!(shown["status"], json!("open"));
    assert_eq!(shown["derivedStatus"], json!("mergedUnverified"));
    assert_eq!(shown["audit"], Value::Null);
}

#[test]
fn an_audit_with_a_not_met_verdict_leaves_the_merged_slice_unverified_and_names_the_criterion() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (_plan, slice) = linked_slice(&home, &gh);
    let file = verdicts(
        &home,
        &json!([{ "criterion": "s1", "verdict": "not-met", "evidence": "One test fails." }]),
    );
    let run = audit(&home, None, &slice, HEAD, &file);
    assert_eq!(run.exit_code, 0, "audit: {}", run.stderr);

    merge_and_refresh(&home, &gh, 7, HEAD);

    let shown = home.show_json(&slice);
    assert_eq!(shown["derivedStatus"], json!("mergedUnverified"));
    assert_eq!(shown["audit"]["counts"], json!(false));
    assert_eq!(
        shown["audit"]["reasons"],
        json!([{ "reason": "notMet", "criterion": "s1" }])
    );
}

#[test]
fn a_new_head_on_the_open_pr_puts_the_audit_behind_until_an_audit_of_that_head() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (_plan, slice) = linked_slice(&home, &gh);
    let file = verdicts(&home, &json!([met("s1")]));
    let first = audit(&home, None, &slice, HEAD, &file);
    assert_eq!(first.exit_code, 0, "audit: {}", first.stderr);
    gh.open_pr(REPOSITORY, 7, NEW_HEAD);

    let refresh = home.tikk_with_gh(&gh, None, &["pr", "refresh", "--json"]);

    assert_eq!(refresh.exit_code, 0, "refresh: {}", refresh.stderr);
    assert_eq!(parse_json(&refresh.stdout)["auditBehind"], json!([slice]));
    let shown = home.show_json(&slice);
    assert_eq!(shown["derivedStatus"], json!("auditBehind"));
    assert_eq!(
        shown["audit"]["reasons"],
        json!([{ "reason": "headDiffers" }])
    );

    let again = audit(&home, None, &slice, NEW_HEAD, &file);

    assert_eq!(again.exit_code, 0, "audit: {}", again.stderr);
    let refresh = home.tikk_with_gh(&gh, None, &["pr", "refresh", "--json"]);
    assert_eq!(parse_json(&refresh.stdout)["auditBehind"], json!([]));
    let shown = home.show_json(&slice);
    assert_eq!(shown["derivedStatus"], json!("open"));
    assert_eq!(shown["audit"]["counts"], json!(true));
    assert_eq!(shown["audit"]["reasons"], json!([]));
}

#[test]
fn a_changed_expected_text_voids_the_earlier_audit() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (_plan, slice) = linked_slice(&home, &gh);
    let file = verdicts(&home, &json!([met("s1")]));
    let run = audit(&home, None, &slice, HEAD, &file);
    assert_eq!(run.exit_code, 0, "audit: {}", run.stderr);
    merge_and_refresh(&home, &gh, 7, HEAD);
    let shown = home.show_json(&slice);
    let changed = shown["document"]
        .as_str()
        .expect("show prints the document")
        .replace("The tests pass.", "Every test passes.");
    let document = home.document("changed.md", &changed);

    let write = home.tikk(&[
        "write",
        &slice,
        "--file",
        document.to_str().expect("a UTF-8 path"),
        "--hash",
        shown["hash"].as_str().expect("show prints the hash"),
        "--json",
    ]);

    assert_eq!(write.exit_code, 0, "write: {}", write.stderr);
    let shown = home.show_json(&slice);
    assert_eq!(shown["derivedStatus"], json!("mergedUnverified"));
    assert_eq!(
        shown["audit"]["reasons"],
        json!([{ "reason": "criterionChanged", "criterion": "s1" }])
    );
}

#[test]
fn a_plan_whose_two_slices_are_done_is_done_with_an_open_instruction_under_one() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let file = verdicts(&home, &json!([met("s1")]));
    let mut slices = Vec::new();

    for (number, title) in [(7, "First"), (8, "Second")] {
        let slice = home.slice_under(&plan, title, &[]);
        let url = format!("https://github.com/owner/app/pull/{number}");
        gh.merged_pr(
            REPOSITORY,
            number,
            support::TRUNK,
            HEAD,
            "3333333333333333333333333333333333333333",
        );
        let link = home.tikk_with_gh(&gh, None, &["pr", "link", &slice, &url, "--json"]);
        assert_eq!(link.exit_code, 0, "pr link: {}", link.stderr);
        let run = audit(&home, None, &slice, HEAD, &file);
        assert_eq!(run.exit_code, 0, "audit: {}", run.stderr);
        slices.push(slice);
    }

    let instruction = home.new_ticket(&["instruction", "Write the docs", "--parent", &slices[0]]);

    let shown = home.show_json(&plan);
    assert_eq!(shown["status"], json!("open"));
    assert_eq!(shown["derivedStatus"], json!("done"), "{shown}");
    assert_eq!(home.show_json(&instruction)["status"], json!("open"));
    assert_eq!(home.show_json(&slices[0])["derivedStatus"], json!("done"));
}

#[test]
fn ls_and_show_keep_the_stored_status_and_done_still_refuses_a_slice() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (plan, slice) = linked_slice(&home, &gh);
    let task = home.new_ticket(&["task", "Renew the domain", "--parent", &plan]);
    let file = verdicts(&home, &json!([met("s1")]));
    let run = audit(&home, None, &slice, HEAD, &file);
    assert_eq!(run.exit_code, 0, "audit: {}", run.stderr);
    merge_and_refresh(&home, &gh, 7, HEAD);

    let listed = home.tikk(&["ls", "--status", "open", "--json"]);

    assert_eq!(listed.exit_code, 0, "ls: {}", listed.stderr);
    let rows = parse_json(&listed.stdout)["tickets"].clone();
    let row = |id: &str| {
        rows.as_array()
            .expect("ls lists tickets")
            .iter()
            .find(|row| row["id"] == json!(id))
            .cloned()
            .unwrap_or_else(|| panic!("ls lists {id}: {rows}"))
    };
    assert_eq!(row(&slice)["status"], json!("open"));
    assert_eq!(row(&slice)["derivedStatus"], json!("done"));
    assert_eq!(row(&plan)["derivedStatus"], json!("open"));
    assert_eq!(row(&task).get("derivedStatus"), None);
    let children = home.show_json(&plan)["children"].clone();
    let child = children
        .as_array()
        .expect("show lists the children")
        .iter()
        .find(|child| child["id"] == json!(slice))
        .cloned()
        .unwrap_or_else(|| panic!("show lists {slice}: {children}"));
    assert_eq!(child["status"], json!("open"));
    assert_eq!(child["derivedStatus"], json!("done"));

    let done = home.tikk(&["done", &slice, "--json"]);

    assert_eq!(done.exit_code, 1, "stdout: {}", done.stdout);
    assert_eq!(
        parse_json(&done.stderr)["error"]["code"],
        json!("wrongKind")
    );
}

#[test]
fn show_and_ls_text_print_the_derived_state_and_whether_the_audit_counts() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (plan, slice) = linked_slice(&home, &gh);
    let file = verdicts(&home, &json!([]));
    let run = audit(&home, None, &slice, HEAD, &file);
    assert_eq!(run.exit_code, 0, "audit: {}", run.stderr);
    merge_and_refresh(&home, &gh, 7, HEAD);

    let show = home.tikk(&["show", &slice]);
    let ls = home.tikk(&["ls", "--parent", &plan]);

    assert_eq!(show.exit_code, 0, "show: {}", show.stderr);
    assert!(
        show.stdout.starts_with(&format!(
            "{slice}  slice  open (mergedUnverified)  {plan}  Add the store\n"
        )),
        "{}",
        show.stdout
    );
    assert!(
        show.stdout.contains(&format!(
            "\naudit of {REPOSITORY} at {HEAD}: 0 of 0 met, at "
        )),
        "{}",
        show.stdout
    );
    assert!(
        show.stdout
            .contains(", does not count (criterionMissing s1)\n"),
        "{}",
        show.stdout
    );
    assert_eq!(
        ls.stdout,
        format!("{slice}  slice  open (mergedUnverified)  {plan}  Add the store\n")
    );
}

#[test]
fn a_stored_audit_verdict_with_blank_evidence_does_not_count() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (_plan, slice) = linked_slice(&home, &gh);
    merge_and_refresh(&home, &gh, 7, HEAD);
    let line = json!({
        "v": 1,
        "kind": "audit",
        "ticket": slice,
        "at": "2026-11-13T02:00:00Z",
        "repository": REPOSITORY,
        "head": HEAD,
        "ticketHash": hash_of(&home, &slice),
        "verdicts": [{
            "criterion": "s1",
            "check": "cargo nextest run",
            "expected": "The tests pass.",
            "verdict": "met",
            "evidence": " ",
        }],
    });
    home.append_fact_line("2026-11.jsonl", &line.to_string());

    let shown = home.show_json(&slice);

    assert_eq!(shown["derivedStatus"], json!("mergedUnverified"), "{shown}");
    assert_eq!(shown["audit"], Value::Null, "{shown}");
}

fn done_slice(home: &Home, gh: &FakeGh) -> (String, String) {
    let (plan, slice) = linked_slice(home, gh);
    let file = verdicts(home, &json!([met("s1")]));
    let run = audit(home, None, &slice, HEAD, &file);
    assert_eq!(run.exit_code, 0, "audit: {}", run.stderr);
    merge_and_refresh(home, gh, 7, HEAD);
    assert_eq!(home.show_json(&slice)["derivedStatus"], json!("done"));

    (plan, slice)
}

fn listed_row(home: &Home, id: &str) -> Value {
    let run = home.tikk(&["ls", "--json"]);
    assert_eq!(run.exit_code, 0, "ls: {}", run.stderr);

    parse_json(&run.stdout)["tickets"]
        .as_array()
        .expect("ls lists tickets")
        .iter()
        .find(|row| row["id"] == json!(id))
        .cloned()
        .unwrap_or_else(|| panic!("ls lists {id}"))
}

#[test]
fn an_unreadable_fact_line_keeps_a_merged_slice_from_reading_done() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (plan, slice) = done_slice(&home, &gh);
    let blocked = home.slice_under(&plan, "Add the lease", &[&slice]);

    home.append_fact_line("2026-11.jsonl", "{\"v\":1,\"kind\":\"audit\"");

    let shown = home.show_json(&slice);
    assert_eq!(shown["derivedStatus"], json!("mergedUnverified"), "{shown}");
    assert_eq!(
        listed_row(&home, &slice)["derivedStatus"],
        json!("mergedUnverified")
    );
    assert_eq!(home.show_json(&plan)["derivedStatus"], json!("open"));
    let ready = home.tikk(&["ready", "--parent", &plan, "--json"]);
    assert_eq!(ready.exit_code, 0, "ready: {}", ready.stderr);
    let queue = parse_json(&ready.stdout);
    assert_eq!(queue["candidates"], json!([]), "{queue}");
    let holds: Vec<Value> = queue["skipped"]
        .as_array()
        .expect("ready lists skipped slices")
        .iter()
        .map(|row| json!([row["id"], row["holds"][0]["reason"]]))
        .collect();
    assert_eq!(
        holds,
        [
            json!([slice, "mergedUnverified"]),
            json!([blocked, "blockedBy"])
        ],
        "{queue}"
    );
    assert_ne!(queue["errors"], json!([]), "{queue}");
}

#[test]
fn an_unreadable_ticket_file_keeps_a_plan_from_reading_done() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (plan, _slice) = done_slice(&home, &gh);
    let open = home.slice_under(&plan, "Add the lease", &[]);
    assert_eq!(home.show_json(&plan)["derivedStatus"], json!("open"));
    let file = home
        .ticket_files()
        .into_iter()
        .find(|path| path.to_string_lossy().contains(&open))
        .expect("the open slice has a file");

    std::fs::write(&file, "---\nkind: [\n---\n").expect("break the slice file");

    let shown = home.show_json(&plan);
    assert_eq!(shown["derivedStatus"], json!("open"), "{shown}");
    assert_eq!(listed_row(&home, &plan)["derivedStatus"], json!("open"));
}
