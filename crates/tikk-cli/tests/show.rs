mod support;

use serde_json::json;
use sha2::{Digest, Sha256};

use support::{Home, parse_json};

#[test]
fn show_json_of_a_slice_lists_its_instruction_with_the_hash_and_body() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let slice = home.new_ticket(&["slice", "Add ticket files", "--parent", &plan]);
    let instruction = home.new_ticket(&["instruction", "Write the parser", "--parent", &slice]);

    let run = home.tikk(&["show", &slice, "--json"]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    let shown = parse_json(&run.stdout);
    assert_eq!(shown["id"], json!(slice));
    assert_eq!(shown["kind"], json!("slice"));
    assert_eq!(shown["parent"], json!(plan));
    assert_eq!(
        shown["children"],
        json!([{
            "id": instruction,
            "title": "Write the parser",
            "kind": "instruction",
            "status": "open",
            "parent": slice,
        }])
    );
    let path = shown["path"].as_str().expect("show prints the file path");
    let bytes = std::fs::read(path).expect("read the slice file");
    let expected: String = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(shown["hash"], json!(expected));
    assert_eq!(shown["body"], json!(""));
}

#[test]
fn show_json_returns_the_body_of_a_ticket_document() {
    let home = Home::initialized();
    let document = home.document(
        "plan.md",
        "---\nkind: plan\ntitle: Move to tikk\n---\nThe plan's design.\n",
    );
    let plan = home.new_ticket(&["--file", document.to_str().expect("a UTF-8 path")]);

    let run = home.tikk(&["show", &plan, "--json"]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(
        parse_json(&run.stdout)["body"],
        json!("The plan's design.\n")
    );
}

#[test]
fn show_json_lists_the_files_of_the_ticket_folder() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let folder = home.store().join("tickets/personal").join(&plan);
    std::fs::create_dir_all(folder.join("reports")).expect("create the ticket folder");
    std::fs::write(folder.join("design.md"), "design").expect("write a design file");
    std::fs::write(folder.join("reports/audit.md"), "audit").expect("write a report file");

    let run = home.tikk(&["show", &plan, "--json"]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(
        parse_json(&run.stdout)["files"],
        json!(["design.md", "reports/audit.md"])
    );
}

#[test]
fn show_of_an_unknown_id_is_not_found() {
    let home = Home::initialized();

    let run = home.tikk(&["show", "personal-abcd", "--json"]);

    assert_eq!(run.exit_code, 1);
    assert_eq!(run.stdout, "");
    assert_eq!(parse_json(&run.stderr)["error"]["code"], json!("notFound"));
}

#[test]
fn show_of_a_malformed_id_is_wrong_usage() {
    let home = Home::initialized();

    let run = home.tikk(&["show", "personal-ab", "--json"]);

    assert_eq!(run.exit_code, 2);
    assert_eq!(
        parse_json(&run.stderr)["error"]["code"],
        json!("invalidArguments")
    );
}

#[test]
fn show_without_json_prints_the_ticket_and_its_children() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let task = home.new_ticket(&["task", "Ask about Windows", "--parent", &plan]);

    let run = home.tikk(&["show", &plan]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert!(
        run.stdout
            .starts_with(&format!("{plan}  plan  open  -  Move to tikk\n")),
        "{}",
        run.stdout
    );
    assert!(
        run.stdout
            .contains(&format!("{task}  task  open  {plan}  Ask about Windows\n")),
        "{}",
        run.stdout
    );
}
