mod support;

use serde_json::{Value, json};

use support::audit::{
    HEAD, REPOSITORY, audit, audit_with_hash, hash_of, linked_slice, met, verdicts,
};
use support::{FakeGh, Home, parse_json, run_git};

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
