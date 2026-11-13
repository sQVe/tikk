mod support;

use serde_json::json;

use support::{Home, parse_json};

fn file_text(home: &Home, id: &str) -> String {
    let shown = home.show_json(id);
    let path = shown["path"].as_str().expect("show prints the path");

    std::fs::read_to_string(path).expect("read the ticket file")
}

#[test]
fn move_of_an_instruction_under_a_plan_names_the_parent_field() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let slice = home.new_ticket(&["slice", "Lock the store", "--parent", &plan]);
    let instruction = home.new_ticket(&["instruction", "Write the lock", "--parent", &slice]);
    let before = file_text(&home, &instruction);

    let run = home.tikk(&["move", &instruction, "--parent", &plan, "--json"]);

    assert_eq!(run.exit_code, 1, "stdout: {}", run.stdout);
    let error = &parse_json(&run.stderr)["error"];
    assert_eq!(error["code"], json!("invalidTicket"));
    assert_eq!(error["field"], json!("parent"));
    assert_eq!(file_text(&home, &instruction), before);
}

#[test]
fn move_puts_a_task_under_a_plan_clears_its_rank_and_no_parent_makes_it_loose() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let task = home.new_ticket(&["task", "Renew the domain"]);
    let rank = home.tikk(&["rank", &task, "--first"]);
    assert_eq!(rank.exit_code, 0, "rank: {}", rank.stderr);
    assert_eq!(home.show_json(&task)["rank"], json!(1));

    let moved = home.tikk(&["move", &task, "--parent", &plan, "--json"]);

    assert_eq!(moved.exit_code, 0, "move: {}", moved.stderr);
    assert_eq!(parse_json(&moved.stdout)["parent"], json!(plan));
    let shown = home.show_json(&task);
    assert_eq!(shown["parent"], json!(plan));
    assert_eq!(shown["rank"], json!(null));

    let loose = home.tikk(&["move", &task, "--no-parent", "--json"]);

    assert_eq!(loose.exit_code, 0, "move --no-parent: {}", loose.stderr);
    assert_eq!(home.show_json(&task)["parent"], json!(null));
}

#[test]
fn move_to_the_parent_it_has_changes_nothing() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let task = home.new_ticket(&["task", "Renew the domain", "--parent", &plan]);
    let rank = home.tikk(&["rank", &task, "--first"]);
    assert_eq!(rank.exit_code, 0, "rank: {}", rank.stderr);
    let before = file_text(&home, &task);

    let run = home.tikk(&["move", &task, "--parent", &plan]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(file_text(&home, &task), before);
}

#[test]
fn move_to_a_parent_in_another_project_names_the_parent_field() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Ship tikk", "--project", "tikk"]);
    let task = home.new_ticket(&["task", "Renew the domain", "--project", "personal"]);
    let before = file_text(&home, &task);

    let run = home.tikk(&["move", &task, "--parent", &plan, "--json"]);

    assert_eq!(run.exit_code, 1, "stdout: {}", run.stdout);
    let error = &parse_json(&run.stderr)["error"];
    assert_eq!(error["code"], json!("invalidTicket"));
    assert_eq!(error["field"], json!("parent"));
    assert_eq!(file_text(&home, &task), before);
}

#[test]
fn move_under_a_plan_that_waits_on_the_task_is_a_cycle_through_parent() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let task = home.new_ticket(&["task", "Renew the domain"]);
    let block = home.tikk(&["block", &plan, &task]);
    assert_eq!(block.exit_code, 0, "block: {}", block.stderr);
    let before = file_text(&home, &task);

    let run = home.tikk(&["move", &task, "--parent", &plan, "--json"]);

    assert_eq!(run.exit_code, 1, "stdout: {}", run.stdout);
    let error = &parse_json(&run.stderr)["error"];
    assert_eq!(error["code"], json!("cycle"));
    assert_eq!(error["field"], json!("parent"));
    assert_eq!(
        error["message"],
        json!(format!(
            "`parent` would make a cycle: {task} has the parent {plan}, {plan} is blocked by {task}."
        ))
    );
    assert_eq!(file_text(&home, &task), before);
}

#[test]
fn move_without_a_parent_choice_exits_with_2() {
    let home = Home::initialized();
    let task = home.new_ticket(&["task", "Renew the domain"]);

    for arguments in [
        vec!["move", task.as_str()],
        vec![
            "move",
            task.as_str(),
            "--no-parent",
            "--parent",
            task.as_str(),
        ],
    ] {
        let run = home.tikk(&arguments);

        assert_eq!(run.exit_code, 2, "case {arguments:?}: {}", run.stdout);
    }
}
