mod support;

use serde_json::json;

use support::{Home, parse_json};

#[test]
fn cancel_stores_the_status_and_the_reason_in_the_file() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);

    let run = home.tikk(&["cancel", &plan, "--reason", "Out of scope", "--json"]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(parse_json(&run.stdout)["status"], json!("canceled"));
    let shown = home.show_json(&plan);
    assert_eq!(shown["status"], json!("canceled"));
    assert_eq!(shown["reason"], json!("Out of scope"));
    assert_eq!(
        shown["document"],
        json!(
            "---\nkind: plan\ntitle: Move to tikk\nstatus: canceled\nreason: Out of scope\n---\n"
        )
    );
}

#[test]
fn cancel_without_a_reason_exits_with_2() {
    let home = Home::initialized();
    let task = home.new_ticket(&["task", "Renew the domain"]);

    let run = home.tikk(&["cancel", &task, "--json"]);

    assert_eq!(run.exit_code, 2, "stdout: {}", run.stdout);
    let error = &parse_json(&run.stderr)["error"];
    assert_eq!(error["code"], json!("invalidArguments"));
    assert_eq!(
        error["message"],
        json!("the following required arguments were not provided: --reason <TEXT>")
    );
    assert_eq!(home.show_json(&task)["status"], json!("open"));
}

#[test]
fn cancel_with_a_blank_reason_is_refused_and_names_the_field() {
    let home = Home::initialized();
    let task = home.new_ticket(&["task", "Renew the domain"]);

    let run = home.tikk(&["cancel", &task, "--reason", "  ", "--json"]);

    assert_eq!(run.exit_code, 1, "stdout: {}", run.stdout);
    let error = &parse_json(&run.stderr)["error"];
    assert_eq!(error["code"], json!("invalidTicket"));
    assert_eq!(error["field"], json!("reason"));
    assert_eq!(home.show_json(&task)["status"], json!("open"));
}

#[test]
fn cancel_of_an_unknown_id_exits_with_1_and_not_found() {
    let home = Home::initialized();

    let run = home.tikk(&["cancel", "personal-wxyz", "--reason", "Gone", "--json"]);

    assert_eq!(run.exit_code, 1, "stdout: {}", run.stdout);
    assert_eq!(parse_json(&run.stderr)["error"]["code"], json!("notFound"));
}
