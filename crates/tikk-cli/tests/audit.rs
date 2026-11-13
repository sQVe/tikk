mod support;

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use support::{FakeGh, Home, parse_json, run_git};

const REPOSITORY: &str = "owner/app";
const HEAD: &str = "1111111111111111111111111111111111111111";
const NEW_HEAD: &str = "2222222222222222222222222222222222222222";
const URL: &str = "https://github.com/owner/app/pull/7";

fn linked_slice(home: &Home, gh: &FakeGh) -> (String, String) {
    let (plan, slice) = home.plan_and_slice();

    gh.open_pr(REPOSITORY, 7, HEAD);
    let link = home.tikk_with_gh(gh, None, &["pr", "link", &slice, URL, "--json"]);
    assert_eq!(link.exit_code, 0, "pr link: {}", link.stderr);

    (plan, slice)
}

fn verdicts(home: &Home, verdicts: &Value) -> PathBuf {
    home.document("verdicts.json", &verdicts.to_string())
}

fn met(criterion: &str) -> Value {
    json!({ "criterion": criterion, "verdict": "met", "evidence": "The tests pass." })
}

fn hash_of(home: &Home, id: &str) -> String {
    home.show_json(id)["hash"]
        .as_str()
        .expect("show prints the hash")
        .to_owned()
}

fn audit(home: &Home, agent: Option<&str>, slice: &str, head: &str, file: &Path) -> support::Run {
    audit_with_hash(home, agent, slice, &hash_of(home, slice), head, file)
}

fn audit_with_hash(
    home: &Home,
    agent: Option<&str>,
    slice: &str,
    hash: &str,
    head: &str,
    file: &Path,
) -> support::Run {
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

fn merge(home: &Home, gh: &FakeGh, head: &str) {
    gh.merged_pr(
        REPOSITORY,
        7,
        support::TRUNK,
        head,
        "3333333333333333333333333333333333333333",
    );
    let refresh = home.tikk_with_gh(gh, None, &["pr", "refresh", "--json"]);
    assert_eq!(refresh.exit_code, 0, "pr refresh: {}", refresh.stderr);
}

#[test]
fn an_audit_that_meets_every_criterion_makes_the_merged_slice_done() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (_plan, slice) = linked_slice(&home, &gh);
    let file = verdicts(&home, &json!([met("s1")]));

    let run = audit(&home, None, &slice, HEAD, &file);

    assert_eq!(run.exit_code, 0, "audit: {}", run.stderr);
    merge(&home, &gh, HEAD);
    let shown = home.show_json(&slice);
    assert_eq!(shown["status"], json!("open"), "{shown}");
    assert_eq!(shown["derivedStatus"], json!("done"), "{shown}");
    assert_eq!(shown["audit"]["counts"], json!(true), "{shown}");
    assert_eq!(shown["audit"]["reasons"], json!([]), "{shown}");
}

fn audit_facts(home: &Home) -> Vec<Value> {
    home.fact_lines()
        .into_iter()
        .filter(|fact| fact["kind"] == json!("audit"))
        .collect()
}

fn error_of(run: &support::Run) -> Value {
    parse_json(&run.stderr)["error"].clone()
}

#[test]
fn audit_prints_and_records_each_verdict_with_the_criterion_text_it_saw() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (_plan, slice) = linked_slice(&home, &gh);
    let hash = hash_of(&home, &slice);
    let file = verdicts(&home, &json!([met("s1")]));

    let run = audit(&home, None, &slice, HEAD, &file);

    assert_eq!(run.exit_code, 0, "audit: {}", run.stderr);
    let printed = parse_json(&run.stdout);
    let facts = audit_facts(&home);
    assert_eq!(facts.len(), 1);
    let verdict = json!({
        "criterion": "s1",
        "check": "cargo nextest run",
        "expected": "The tests pass.",
        "verdict": "met",
        "evidence": "The tests pass.",
    });
    assert_eq!(printed["id"], json!(slice));
    assert_eq!(printed["audit"]["repository"], json!(REPOSITORY));
    assert_eq!(printed["audit"]["head"], json!(HEAD));
    assert_eq!(printed["audit"]["ticketHash"], json!(hash));
    assert_eq!(printed["audit"]["verdicts"], json!([verdict]));
    assert_eq!(printed["audit"]["at"], facts[0]["at"]);
    assert_eq!(facts[0]["ticket"], json!(slice));
    assert_eq!(facts[0]["repository"], json!(REPOSITORY));
    assert_eq!(facts[0]["head"], json!(HEAD));
    assert_eq!(facts[0]["ticketHash"], json!(hash));
    assert_eq!(facts[0]["verdicts"], json!([verdict]));
}

#[test]
fn a_merged_slice_with_no_audit_is_merged_unverified() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (_plan, slice) = linked_slice(&home, &gh);

    merge(&home, &gh, HEAD);

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

    merge(&home, &gh, HEAD);

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
    merge(&home, &gh, HEAD);
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
fn a_verdict_file_without_a_current_criterion_is_recorded_and_does_not_count() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (_plan, slice) = linked_slice(&home, &gh);
    let file = verdicts(&home, &json!([]));

    let run = audit(&home, None, &slice, HEAD, &file);

    assert_eq!(run.exit_code, 0, "audit: {}", run.stderr);
    assert_eq!(audit_facts(&home).len(), 1);
    assert_eq!(
        home.show_json(&slice)["audit"]["reasons"],
        json!([{ "reason": "criterionMissing", "criterion": "s1" }])
    );
}

#[test]
fn audit_with_a_stale_hash_exits_with_changed_on_disk_and_records_nothing() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (_plan, slice) = linked_slice(&home, &gh);
    let file = verdicts(&home, &json!([met("s1")]));
    let stale = "0".repeat(64);

    let run = audit_with_hash(&home, None, &slice, &stale, HEAD, &file);

    assert_eq!(run.exit_code, 1, "stdout: {}", run.stdout);
    assert_eq!(error_of(&run)["code"], json!("changedOnDisk"));
    assert_eq!(audit_facts(&home), Vec::<Value>::new());
}

#[test]
fn audit_with_a_criterion_the_slice_does_not_have_exits_with_1_and_names_it() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (_plan, slice) = linked_slice(&home, &gh);
    let file = verdicts(&home, &json!([met("s1"), met("s9")]));

    let run = audit(&home, None, &slice, HEAD, &file);

    assert_eq!(run.exit_code, 1, "stdout: {}", run.stdout);
    let error = error_of(&run);
    assert_eq!(error["code"], json!("unknownCriterion"));
    assert!(
        error["message"]
            .as_str()
            .is_some_and(|message| message.contains("`s9`")),
        "{error}"
    );
    assert_eq!(audit_facts(&home), Vec::<Value>::new());
}

#[test]
fn audit_refuses_a_verdict_file_that_is_wrong_with_exit_2() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (_plan, slice) = linked_slice(&home, &gh);
    let cases = [
        ("not JSON", "[{".to_owned()),
        ("not a list", json!(met("s1")).to_string()),
        (
            "an unknown verdict",
            json!([{ "criterion": "s1", "verdict": "passed", "evidence": "x" }]).to_string(),
        ),
        (
            "an empty evidence",
            json!([{ "criterion": "s1", "verdict": "met", "evidence": " " }]).to_string(),
        ),
        (
            "a criterion named twice",
            json!([met("s1"), met("s1")]).to_string(),
        ),
    ];

    for (name, text) in cases {
        let file = home.document("verdicts.json", &text);

        let run = audit(&home, None, &slice, HEAD, &file);

        assert_eq!(run.exit_code, 2, "case {name}: {}", run.stdout);
        assert_eq!(
            error_of(&run)["code"],
            json!("invalidArguments"),
            "case {name}"
        );
    }

    assert_eq!(audit_facts(&home), Vec::<Value>::new());
}

#[test]
fn audit_by_another_agent_on_a_claimed_slice_is_refused_and_by_the_holder_renews_the_lease() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (_plan, slice) = linked_slice(&home, &gh);
    let claim = home.tikk_as("manager", &["claim", &slice, "--json"]);
    assert_eq!(claim.exit_code, 0, "claim: {}", claim.stderr);
    let claimed_end = parse_json(&claim.stdout)["claim"]["leaseEnd"].clone();
    let file = verdicts(&home, &json!([met("s1")]));

    let other = audit(&home, Some("other"), &slice, HEAD, &file);

    assert_eq!(other.exit_code, 1, "stdout: {}", other.stdout);
    assert_eq!(error_of(&other)["code"], json!("claimed"));
    assert_eq!(audit_facts(&home), Vec::<Value>::new());

    let holder = audit(&home, Some("manager"), &slice, HEAD, &file);

    assert_eq!(holder.exit_code, 0, "holder: {}", holder.stderr);
    assert_eq!(audit_facts(&home).len(), 1);
    let renewed_end = home.show_json(&slice)["claim"]["leaseEnd"].clone();
    assert!(
        renewed_end.as_str() > claimed_end.as_str(),
        "the audit moves leaseEnd from {claimed_end} to {renewed_end}"
    );
}

#[test]
fn audit_refuses_a_slice_with_no_criterion_or_a_link_that_fails_the_write_checks() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let bare = home.new_ticket(&["slice", "No criteria", "--parent", &plan]);
    let first = home.slice_under(&plan, "First", &[]);
    let second = home.slice_under(&plan, "Second", &[&first]);
    let path = home.show_json(&first)["path"]
        .as_str()
        .expect("show prints the path")
        .to_owned();
    let text = std::fs::read_to_string(&path).expect("read the first slice");
    std::fs::write(
        &path,
        text.replace(
            &format!("parent: {plan}\n"),
            &format!("parent: {plan}\nblockedBy: [{second}]\n"),
        ),
    )
    .expect("close a cycle by hand");
    let file = verdicts(&home, &json!([met("s1")]));
    let cases = [(&bare, "invalidTicket"), (&first, "cycle")];

    for (slice, code) in cases {
        let run = audit(&home, None, slice, HEAD, &file);

        assert_eq!(run.exit_code, 1, "case {code}: {}", run.stdout);
        assert_eq!(error_of(&run)["code"], json!(code), "case {code}");
    }

    assert_eq!(
        error_of(&audit(&home, None, &bare, HEAD, &file))["field"],
        json!("criteria")
    );
    assert_eq!(audit_facts(&home), Vec::<Value>::new());
}

#[test]
fn audit_refuses_a_ticket_that_is_not_a_slice() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let file = verdicts(&home, &json!([]));

    let run = audit(&home, None, &plan, HEAD, &file);

    assert_eq!(run.exit_code, 1, "stdout: {}", run.stdout);
    assert_eq!(error_of(&run)["code"], json!("wrongKind"));
    assert_eq!(audit_facts(&home), Vec::<Value>::new());
}

#[test]
fn audit_reads_the_repository_from_the_github_origin_of_the_working_directory() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();
    let file = verdicts(&home, &json!([met("s1")]));
    let hash = hash_of(&home, &slice);
    let arguments = |hash: &str| {
        vec![
            "audit".to_owned(),
            slice.clone(),
            "--hash".to_owned(),
            hash.to_owned(),
            "--head".to_owned(),
            HEAD.to_owned(),
            "--file".to_owned(),
            file.to_str().expect("a UTF-8 path").to_owned(),
            "--json".to_owned(),
        ]
    };
    let run_in = |arguments: &[String]| {
        let arguments: Vec<&str> = arguments.iter().map(String::as_str).collect();

        home.tikk(&arguments)
    };

    let outside = run_in(&arguments(&hash));

    assert_eq!(outside.exit_code, 1, "stdout: {}", outside.stdout);
    assert_eq!(error_of(&outside)["code"], json!("noRepository"));

    run_git(&home.work(), &["init", "--quiet"]);
    run_git(
        &home.work(),
        &[
            "remote",
            "add",
            "origin",
            "https://gitlab.com/owner/app.git",
        ],
    );
    let other_host = run_in(&arguments(&hash));

    assert_eq!(other_host.exit_code, 1, "stdout: {}", other_host.stdout);
    assert_eq!(error_of(&other_host)["code"], json!("noRepository"));
    assert_eq!(audit_facts(&home), Vec::<Value>::new());

    run_git(
        &home.work(),
        &[
            "remote",
            "set-url",
            "origin",
            "git@github.com:owner/app.git",
        ],
    );
    let inside = run_in(&arguments(&hash));

    assert_eq!(inside.exit_code, 0, "audit: {}", inside.stderr);
    assert_eq!(
        parse_json(&inside.stdout)["audit"]["repository"],
        json!(REPOSITORY)
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
    merge(&home, &gh, HEAD);

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
    assert_eq!(error_of(&done)["code"], json!("wrongKind"));
}

#[test]
fn show_and_ls_text_print_the_derived_state_and_whether_the_audit_counts() {
    let home = Home::initialized();
    let gh = FakeGh::new();
    let (plan, slice) = linked_slice(&home, &gh);
    let file = verdicts(&home, &json!([]));
    let run = audit(&home, None, &slice, HEAD, &file);
    assert_eq!(run.exit_code, 0, "audit: {}", run.stderr);
    merge(&home, &gh, HEAD);

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
    merge(&home, &gh, HEAD);
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
