mod support;

use serde_json::json;

use support::{Home, parse_json};

#[test]
fn done_marks_a_task_and_an_instruction_done() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let slice = home.new_ticket(&["slice", "Lock the store", "--parent", &plan]);
    let instruction = home.new_ticket(&["instruction", "Write the lock", "--parent", &slice]);
    let task = home.new_ticket(&["task", "Renew the domain"]);

    for id in [&instruction, &task] {
        let run = home.tikk(&["done", id, "--json"]);

        assert_eq!(run.exit_code, 0, "case {id}: {}", run.stderr);
        assert_eq!(
            parse_json(&run.stdout)["status"],
            json!("done"),
            "case {id}"
        );
        assert_eq!(home.show_json(id)["status"], json!("done"), "case {id}");
    }
}

#[test]
fn done_clears_the_reason_of_a_canceled_task() {
    let home = Home::initialized();
    let task = home.new_ticket(&["task", "Renew the domain"]);
    let cancel = home.tikk(&["cancel", &task, "--reason", "Sold the domain"]);
    assert_eq!(cancel.exit_code, 0, "stderr: {}", cancel.stderr);

    let run = home.tikk(&["done", &task]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    let shown = home.show_json(&task);
    assert_eq!(shown["status"], json!("done"));
    assert_eq!(shown["reason"], json!(null));
}

#[test]
fn done_on_a_plan_or_a_slice_exits_with_1_and_names_the_kind() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let slice = home.new_ticket(&["slice", "Lock the store", "--parent", &plan]);

    for (id, kind) in [(&plan, "plan"), (&slice, "slice")] {
        let before = home.show_json(id);

        let run = home.tikk(&["done", id, "--json"]);

        assert_eq!(run.exit_code, 1, "case {kind}: {}", run.stdout);
        let error = &parse_json(&run.stderr)["error"];
        assert_eq!(error["code"], json!("wrongKind"), "case {kind}");
        let message = error["message"].as_str().expect("the error has a message");
        assert!(
            message.contains(&format!("is a {kind}")),
            "case {kind}: {message}"
        );
        assert_eq!(home.show_json(id)["hash"], before["hash"], "case {kind}");
    }
}

#[test]
fn done_without_json_prints_the_ticket_row() {
    let home = Home::initialized();
    let task = home.new_ticket(&["task", "Renew the domain"]);

    let run = home.tikk(&["done", &task]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(
        run.stdout,
        format!("{task}  task  done  -  Renew the domain\n")
    );
}
