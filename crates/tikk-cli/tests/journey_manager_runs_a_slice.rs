mod support;

use serde_json::json;

use support::{Home, parse_json};

#[test]
fn manager_runs_a_slice() {
    let home = Home::initialized();

    let plan_document = home.document(
        "plan.md",
        "---\nkind: plan\ntitle: Move to tikk\nstatus: open\ncriteria:\n  - id: p1\n    check: cargo nextest run\n    expected: The journeys pass.\n---\nThe design.\n",
    );
    let plan = home.new_ticket(&["--file", plan_document.to_str().expect("a UTF-8 path")]);
    let first_document = home.document(
        "first.md",
        &format!(
            "---\nkind: slice\ntitle: Add the store\nstatus: open\nparent: {plan}\ncriteria:\n  - id: s1\n    check: tikk init --json\n    expected: The store exists.\n---\n"
        ),
    );
    let first = home.new_ticket(&["--file", first_document.to_str().expect("a UTF-8 path")]);
    let second_document = home.document(
        "second.md",
        &format!(
            "---\nkind: slice\ntitle: Add ticket files\nstatus: open\nparent: {plan}\nblockedBy: [{first}]\ncriteria:\n  - id: s1\n    check: tikk ls --json\n    expected: The tickets are listed.\n---\n"
        ),
    );
    let second = home.new_ticket(&["--file", second_document.to_str().expect("a UTF-8 path")]);

    let show = home.tikk(&["show", &second, "--json"]);

    assert_eq!(show.exit_code, 0, "step 1, show: {}", show.stderr);
    let shown = parse_json(&show.stdout);
    assert_eq!(shown["blockedBy"], json!([first]), "step 1, blocker");
    assert_eq!(
        shown["criteria"],
        json!([{
            "id": "s1",
            "check": "tikk ls --json",
            "expected": "The tickets are listed.",
        }]),
        "step 1, criterion"
    );
    assert_eq!(shown["parent"], json!(plan), "step 1, parent");
}
