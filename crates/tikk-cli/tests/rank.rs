mod support;

use serde_json::json;

use support::{Home, parse_json};

fn listed_ids(home: &Home, arguments: &[&str]) -> Vec<String> {
    let run = home.tikk(arguments);

    assert_eq!(run.exit_code, 0, "{arguments:?}: {}", run.stderr);

    parse_json(&run.stdout)["tickets"]
        .as_array()
        .expect("ls lists tickets")
        .iter()
        .map(|ticket| ticket["id"].as_str().expect("a row has an ID").to_owned())
        .collect()
}

fn rank(home: &Home, arguments: &[&str]) {
    let mut all = vec!["rank"];

    all.extend_from_slice(arguments);

    let run = home.tikk(&all);

    assert_eq!(run.exit_code, 0, "rank {arguments:?}: {}", run.stderr);
}

fn plan_with_ranked_tasks(home: &Home) -> (String, [String; 3]) {
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let tasks = ["A", "B", "C"].map(|title| home.new_ticket(&["task", title, "--parent", &plan]));

    for task in &tasks {
        rank(home, &[task, "--last"]);
    }

    assert_eq!(
        listed_ids(home, &["ls", "--parent", &plan, "--json"]),
        tasks
    );

    (plan, tasks)
}

fn file_texts(home: &Home) -> Vec<String> {
    home.ticket_files()
        .iter()
        .map(|path| std::fs::read_to_string(path).expect("read a ticket file"))
        .collect()
}

#[test]
fn rank_before_a_sibling_puts_the_ticket_in_front_of_it() {
    let home = Home::initialized();
    let (plan, [a, b, c]) = plan_with_ranked_tasks(&home);

    let run = home.tikk(&["rank", &c, "--before", &a, "--json"]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(parse_json(&run.stdout)["id"], json!(c));
    assert_eq!(
        listed_ids(&home, &["ls", "--parent", &plan, "--json"]),
        [c.clone(), a.clone(), b.clone()]
    );
    let ranks: Vec<_> = [&c, &a, &b]
        .iter()
        .map(|id| home.show_json(id)["rank"].clone())
        .collect();
    assert_eq!(ranks, [json!(1), json!(2), json!(3)]);
}

#[test]
fn rank_first_last_and_after_reorder_the_siblings() {
    let home = Home::initialized();
    let (plan, [a, b, c]) = plan_with_ranked_tasks(&home);
    let cases = [
        (vec![c.as_str(), "--first"], [&c, &a, &b]),
        (vec![c.as_str(), "--last"], [&a, &b, &c]),
        (vec![a.as_str(), "--after", b.as_str()], [&b, &a, &c]),
        (vec![c.as_str(), "--after", b.as_str()], [&b, &c, &a]),
    ];

    for (arguments, expected) in cases {
        rank(&home, &arguments);

        assert_eq!(
            listed_ids(&home, &["ls", "--parent", &plan, "--json"]),
            expected.map(String::clone),
            "case {arguments:?}"
        );
    }
}

#[test]
fn rank_with_a_ticket_that_is_not_a_sibling_exits_with_1_and_names_it() {
    let home = Home::initialized();
    let (_plan, [a, _b, _c]) = plan_with_ranked_tasks(&home);
    let loose = home.new_ticket(&["task", "Renew the domain"]);
    let before = file_texts(&home);

    let run = home.tikk(&["rank", &a, "--before", &loose, "--json"]);

    assert_eq!(run.exit_code, 1, "stdout: {}", run.stdout);
    let error = &parse_json(&run.stderr)["error"];
    assert_eq!(error["code"], json!("notSibling"));
    let message = error["message"].as_str().expect("the error has a message");
    assert!(message.starts_with(&loose), "{message}");
    assert_eq!(file_texts(&home), before);
}

#[test]
fn rank_into_the_place_it_holds_writes_no_file() {
    let home = Home::initialized();
    let (_plan, [a, b, c]) = plan_with_ranked_tasks(&home);
    let before = file_texts(&home);

    for arguments in [
        vec![a.as_str(), "--first"],
        vec![c.as_str(), "--last"],
        vec![b.as_str(), "--before", c.as_str()],
        vec![b.as_str(), "--after", b.as_str()],
    ] {
        rank(&home, &arguments);

        assert_eq!(file_texts(&home), before, "case {arguments:?}");
    }
}

#[test]
fn rank_of_a_loose_task_orders_the_loose_tickets_of_its_project() {
    let home = Home::initialized();
    let first = home.new_ticket(&["task", "Renew the domain", "--project", "personal"]);
    let second = home.new_ticket(&["task", "Pay the bill", "--project", "personal"]);
    let other = home.new_ticket(&["task", "Ship it", "--project", "tikk"]);

    rank(&home, &[&second, "--first"]);
    rank(&home, &[&first, "--after", &second]);

    assert_eq!(
        listed_ids(&home, &["ls", "--project", "personal", "--json"]),
        [second, first.clone()]
    );
    assert_eq!(home.show_json(&other)["rank"], json!(null));

    let run = home.tikk(&["rank", &first, "--before", &other, "--json"]);

    assert_eq!(run.exit_code, 1, "stdout: {}", run.stdout);
    assert_eq!(
        parse_json(&run.stderr)["error"]["code"],
        json!("notSibling")
    );
}

#[test]
fn rank_needs_exactly_one_place() {
    let home = Home::initialized();
    let task = home.new_ticket(&["task", "Renew the domain"]);

    for arguments in [
        vec!["rank", task.as_str()],
        vec!["rank", task.as_str(), "--first", "--last"],
    ] {
        let run = home.tikk(&arguments);

        assert_eq!(run.exit_code, 2, "case {arguments:?}: {}", run.stdout);
    }
}
