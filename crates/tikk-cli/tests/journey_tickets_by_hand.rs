mod support;

use serde_json::json;

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
}
