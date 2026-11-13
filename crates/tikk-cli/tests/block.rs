mod support;

use serde_json::json;

use support::{Home, parse_json};

fn plan_with_two_slices(home: &Home) -> (String, String, String) {
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let first = home.new_ticket(&["slice", "Lock the store", "--parent", &plan]);
    let second = home.new_ticket(&["slice", "Sync the store", "--parent", &plan]);

    (plan, first, second)
}

fn file_text(home: &Home, id: &str) -> String {
    let shown = home.show_json(id);
    let path = shown["path"].as_str().expect("show prints the path");

    std::fs::read_to_string(path).expect("read the ticket file")
}

#[test]
fn block_that_closes_a_cycle_exits_with_1_names_the_cycle_and_writes_nothing() {
    let home = Home::initialized();
    let (_plan, first, second) = plan_with_two_slices(&home);
    let block = home.tikk(&["block", &first, &second]);
    assert_eq!(block.exit_code, 0, "block: {}", block.stderr);
    let first_before = file_text(&home, &first);
    let second_before = file_text(&home, &second);

    let run = home.tikk(&["block", &second, &first, "--json"]);

    assert_eq!(run.exit_code, 1, "stdout: {}", run.stdout);
    assert_eq!(run.stdout, "");
    let error = &parse_json(&run.stderr)["error"];
    assert_eq!(error["code"], json!("cycle"));
    assert_eq!(error["field"], json!("blockedBy"));
    let message = error["message"].as_str().expect("the error has a message");
    let second_at = message.find(second.as_str()).expect("the cycle names B");
    let first_at = message.find(first.as_str()).expect("the cycle names A");
    assert!(second_at < first_at, "B starts the cycle: {message}");
    assert!(
        message.trim_end_matches('.').ends_with(second.as_str()),
        "the cycle ends with B: {message}"
    );
    assert_eq!(file_text(&home, &first), first_before);
    assert_eq!(file_text(&home, &second), second_before);
}

#[test]
fn block_then_unblock_adds_and_removes_the_blocker() {
    let home = Home::initialized();
    let (_plan, first, second) = plan_with_two_slices(&home);

    let block = home.tikk(&["block", &first, &second, "--json"]);

    assert_eq!(block.exit_code, 0, "block: {}", block.stderr);
    assert_eq!(parse_json(&block.stdout)["id"], json!(first));
    assert_eq!(home.show_json(&first)["blockedBy"], json!([second]));

    let unblock = home.tikk(&["unblock", &first, &second, "--json"]);

    assert_eq!(unblock.exit_code, 0, "unblock: {}", unblock.stderr);
    assert_eq!(home.show_json(&first)["blockedBy"], json!([]));
}

#[test]
fn block_of_a_plan_by_its_own_slice_names_the_parent_link() {
    let home = Home::initialized();
    let (plan, first, _second) = plan_with_two_slices(&home);
    let before = file_text(&home, &plan);

    let run = home.tikk(&["block", &plan, &first, "--json"]);

    assert_eq!(run.exit_code, 1, "stdout: {}", run.stdout);
    let error = &parse_json(&run.stderr)["error"];
    assert_eq!(error["code"], json!("cycle"));
    let message = error["message"].as_str().expect("the error has a message");
    assert!(message.contains(&plan), "{message}");
    assert!(message.contains(&first), "{message}");
    assert!(message.contains("parent"), "{message}");
    assert_eq!(file_text(&home, &plan), before);
}

#[test]
fn block_by_itself_is_a_cycle_of_one() {
    let home = Home::initialized();
    let task = home.new_ticket(&["task", "Renew the domain"]);

    let run = home.tikk(&["block", &task, &task, "--json"]);

    assert_eq!(run.exit_code, 1, "stdout: {}", run.stdout);
    assert_eq!(parse_json(&run.stderr)["error"]["code"], json!("cycle"));
    assert_eq!(home.show_json(&task)["blockedBy"], json!([]));
}

#[test]
fn block_with_a_missing_ticket_or_blocker_exits_with_1_and_not_found() {
    let home = Home::initialized();
    let task = home.new_ticket(&["task", "Renew the domain"]);
    let missing = "personal-zzzz";

    for arguments in [[task.as_str(), missing], [missing, task.as_str()]] {
        let run = home.tikk(&["block", arguments[0], arguments[1], "--json"]);

        assert_eq!(run.exit_code, 1, "case {arguments:?}: {}", run.stdout);
        let error = &parse_json(&run.stderr)["error"];
        assert_eq!(error["code"], json!("notFound"), "case {arguments:?}");
        let message = error["message"].as_str().expect("the error has a message");
        assert!(message.contains(missing), "case {arguments:?}: {message}");
    }
    assert_eq!(home.show_json(&task)["blockedBy"], json!([]));
}

#[test]
fn block_twice_and_unblock_of_a_missing_edge_change_nothing() {
    let home = Home::initialized();
    let task = home.new_ticket(&["task", "Renew the domain"]);
    let blocker = home.new_ticket(&["task", "Pay the bill"]);
    let block = home.tikk(&["block", &task, &blocker]);
    assert_eq!(block.exit_code, 0, "block: {}", block.stderr);
    let before = file_text(&home, &task);

    let again = home.tikk(&["block", &task, &blocker]);
    let unblock_other = home.tikk(&["unblock", &task, &task]);

    assert_eq!(again.exit_code, 0, "block again: {}", again.stderr);
    assert_eq!(
        unblock_other.exit_code, 0,
        "unblock: {}",
        unblock_other.stderr
    );
    assert_eq!(file_text(&home, &task), before);
}

#[test]
fn block_without_json_prints_the_ticket_row() {
    let home = Home::initialized();
    let task = home.new_ticket(&["task", "Renew the domain"]);
    let blocker = home.new_ticket(&["task", "Pay the bill"]);

    let run = home.tikk(&["block", &task, &blocker]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(
        run.stdout,
        format!("{task}  task  open  -  Renew the domain\n")
    );
}
