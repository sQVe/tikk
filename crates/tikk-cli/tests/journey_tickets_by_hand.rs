mod support;

use serde_json::{Value, json};

use support::{Home, parse_json};

fn new_id(home: &Home, arguments: &[&str]) -> String {
    let run = home.tikk(arguments);

    assert_eq!(run.exit_code, 0, "step 2, {arguments:?}: {}", run.stderr);

    let id = run.stdout.trim_end().to_owned();

    assert!(
        id.starts_with("personal-") && !id.contains('\n'),
        "step 2, {arguments:?} prints one ID: {}",
        run.stdout
    );

    id
}

fn listed_titles(home: &Home, arguments: &[&str]) -> Vec<String> {
    let run = home.tikk(arguments);

    assert_eq!(run.exit_code, 0, "step 3, {arguments:?}: {}", run.stderr);

    let mut titles: Vec<String> = parse_json(&run.stdout)["tickets"]
        .as_array()
        .expect("ls lists tickets")
        .iter()
        .map(|ticket| {
            ticket["title"]
                .as_str()
                .expect("a row has a title")
                .to_owned()
        })
        .collect();

    titles.sort();

    titles
}

#[test]
fn tickets_by_hand() {
    let home = Home::new();

    let first = home.tikk(&["init"]);
    assert_eq!(first.exit_code, 0, "step 1, first init: {}", first.stderr);
    assert!(
        first.stdout.contains("Created the tikk store"),
        "step 1, first init: {}",
        first.stdout
    );

    let second = home.tikk(&["init"]);
    assert_eq!(
        second.exit_code, 0,
        "step 1, second init: {}",
        second.stderr
    );
    assert!(
        second.stdout.contains("already exists"),
        "step 1, second init: {}",
        second.stdout
    );

    let plan = new_id(&home, &["new", "plan", "Move to tikk"]);
    let titles = [
        "Decide the lease length",
        "Write the import note",
        "Ask about Windows",
    ];

    let tasks: Vec<String> = titles
        .iter()
        .map(|title| new_id(&home, &["new", "task", title, "--parent", &plan]))
        .collect();
    let lease = &tasks[0];
    let import = &tasks[1];
    let windows = &tasks[2];

    assert_eq!(
        listed_titles(&home, &["ls", "--parent", &plan, "--json"]),
        [
            "Ask about Windows",
            "Decide the lease length",
            "Write the import note"
        ],
        "step 3, ls --parent"
    );
    assert_eq!(
        listed_titles(&home, &["ls", "--search", "lease", "--json"]),
        ["Decide the lease length"],
        "step 3, ls --search lease"
    );

    let cancel = home.tikk(&["cancel", windows, "--reason", "Linux and macOS only"]);
    assert_eq!(cancel.exit_code, 0, "step 4, cancel: {}", cancel.stderr);
    let shown = home.show_json(windows);
    assert_eq!(shown["status"], json!("canceled"), "step 4, show");
    assert_eq!(
        shown["reason"],
        json!("Linux and macOS only"),
        "step 4, show"
    );

    let no_reason = home.tikk(&["cancel", &tasks[0]]);
    assert_eq!(
        no_reason.exit_code, 2,
        "step 4, cancel without --reason: {}",
        no_reason.stdout
    );
    assert_eq!(
        home.show_json(&tasks[0])["status"],
        json!("open"),
        "step 4, cancel without --reason changes nothing"
    );

    let rank = home.tikk(&["rank", import, "--first"]);
    assert_eq!(rank.exit_code, 0, "step 5, rank: {}", rank.stderr);
    assert_eq!(
        listed_rows(&home, &plan)[0]["id"],
        json!(import),
        "step 5, ls --parent lists the import task first"
    );

    let block = home.tikk(&["block", lease, import]);
    assert_eq!(block.exit_code, 0, "step 6, block: {}", block.stderr);
    assert_eq!(
        home.show_json(lease)["blockedBy"],
        json!([import]),
        "step 6, show lists the blocker"
    );
    let reverse = home.tikk(&["block", import, lease, "--json"]);
    assert_eq!(
        reverse.exit_code, 1,
        "step 6, reverse block: {}",
        reverse.stdout
    );
    let error = &parse_json(&reverse.stderr)["error"];
    assert_eq!(error["code"], json!("cycle"), "step 6, reverse block");
    let message = error["message"].as_str().expect("the error has a message");
    assert!(
        message.contains(import.as_str()) && message.contains(lease.as_str()),
        "step 6, the error names the cycle: {message}"
    );

    let mut others = [lease, windows];
    others.sort();
    let rows: Vec<(Value, Value)> = listed_rows(&home, &plan)
        .iter()
        .map(|row| (row["id"].clone(), row["status"].clone()))
        .collect();
    let status_of = |id: &String| if id == windows { "canceled" } else { "open" };
    assert_eq!(
        rows,
        [import, others[0], others[1]].map(|id| (json!(id), json!(status_of(id)))),
        "end state, ls --parent"
    );
    assert_eq!(
        home.show_json(lease)["blockedBy"],
        json!([import]),
        "end state, the lease task waits on the import task"
    );
    assert_eq!(
        home.show_json(windows)["reason"],
        json!("Linux and macOS only"),
        "end state, the Windows task keeps its reason"
    );
}

fn listed_rows(home: &Home, plan: &str) -> Vec<Value> {
    let run = home.tikk(&["ls", "--parent", plan, "--json"]);

    assert_eq!(run.exit_code, 0, "ls --parent: {}", run.stderr);

    parse_json(&run.stdout)["tickets"]
        .as_array()
        .expect("ls lists tickets")
        .clone()
}
