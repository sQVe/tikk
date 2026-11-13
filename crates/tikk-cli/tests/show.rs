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
fn show_json_prints_every_field_of_the_ticket() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let blocker = home.new_ticket(&["task", "Decide the lease length", "--parent", &plan]);
    let document = home.document(
        "slice.md",
        &format!(
            "---\nkind: slice\ntitle: Lock the store\nstatus: canceled\nreason: Out of scope\nparent: {plan}\nrank: 2\nblockedBy: [{blocker}]\ndiscoveredFrom: {blocker}\nrelated: [{plan}]\ncriteria:\n  - id: c1\n    check: cargo nextest run\n    expected: passes\n---\nBody\n"
        ),
    );
    let slice = home.new_ticket(&["--file", document.to_str().expect("a UTF-8 path")]);
    let bare = home.new_ticket(&["task", "Renew the domain"]);

    let full = home.tikk(&["show", &slice, "--json"]);
    let empty = home.tikk(&["show", &bare, "--json"]);

    assert_eq!(full.exit_code, 0, "stderr: {}", full.stderr);
    let shown = parse_json(&full.stdout);
    let path = shown["path"]
        .as_str()
        .expect("show prints the path")
        .to_owned();
    let hash = shown["hash"]
        .as_str()
        .expect("show prints the hash")
        .to_owned();
    let file_text = std::fs::read_to_string(&path).expect("read the slice file");
    assert_eq!(
        shown,
        json!({
            "id": slice,
            "project": "personal",
            "kind": "slice",
            "title": "Lock the store",
            "status": "canceled",
            "reason": "Out of scope",
            "parent": plan,
            "rank": 2,
            "blockedBy": [blocker],
            "discoveredFrom": blocker,
            "related": [plan],
            "criteria": [{ "id": "c1", "check": "cargo nextest run", "expected": "passes" }],
            "path": path,
            "hash": hash,
            "body": "Body\n",
            "document": file_text,
            "children": [],
            "files": [],
            "claim": null,
            "pr": null,
            "questions": [],
            "derivedStatus": "canceled",
            "audit": null,
        })
    );
    assert_eq!(empty.exit_code, 0, "stderr: {}", empty.stderr);
    let bare_shown = parse_json(&empty.stdout);
    for (key, expected) in [
        ("reason", json!(null)),
        ("parent", json!(null)),
        ("rank", json!(null)),
        ("blockedBy", json!([])),
        ("discoveredFrom", json!(null)),
        ("related", json!([])),
        ("criteria", json!([])),
    ] {
        assert_eq!(bare_shown[key], expected, "case {key}");
    }
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
fn show_json_document_is_the_exact_text_of_a_hand_edited_file() {
    let home = Home::initialized();
    let id = home.new_ticket(&["task", "Renew the domain"]);
    let path = home.show_json(&id)["path"]
        .as_str()
        .expect("show prints the path")
        .to_owned();
    let hand_edit = "---\ntitle: Renew the domain # by May\nkind:   task\n---\n\nNotes.\n";
    std::fs::write(&path, hand_edit).expect("edit the ticket file by hand");

    let shown = home.show_json(&id);

    assert_eq!(shown["document"], json!(hand_edit));
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
fn show_json_lists_a_symlink_in_the_ticket_folder_as_one_file() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let folder = home.store().join("tickets/personal").join(&plan);
    let outside = home.work().join("outside");
    std::fs::create_dir_all(outside.join("deep")).expect("create an outside folder");
    std::fs::write(outside.join("deep/secret.md"), "secret").expect("write an outside file");
    std::fs::create_dir_all(&folder).expect("create the ticket folder");
    std::os::unix::fs::symlink(&folder, folder.join("loop")).expect("link the folder to itself");
    std::os::unix::fs::symlink(&outside, folder.join("elsewhere"))
        .expect("link to an outside folder");

    let run = home.tikk(&["show", &plan, "--json"]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(
        parse_json(&run.stdout)["files"],
        json!(["elsewhere", "loop"])
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

#[test]
fn show_without_json_prints_the_reason_children_and_body() {
    let home = Home::initialized();
    let document = home.document(
        "plan.md",
        "---\nkind: plan\ntitle: Move to tikk\nstatus: canceled\nreason: Out of scope\n---\nThe design.\n\nMore text.\n\n",
    );
    let plan = home.new_ticket(&["--file", document.to_str().expect("a UTF-8 path")]);
    let task = home.new_ticket(&["task", "Ask about Windows", "--parent", &plan]);

    let run = home.tikk(&["show", &plan]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(
        run.stdout,
        format!(
            "{plan}  plan  canceled  -  Move to tikk\nreason: Out of scope\n  {task}  task  open  {plan}  Ask about Windows\n\nThe design.\n\nMore text.\n"
        )
    );
}

#[test]
fn show_without_json_leaves_out_an_empty_reason_and_body() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);

    let run = home.tikk(&["show", &plan]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(run.stdout, format!("{plan}  plan  open  -  Move to tikk\n"));
}

#[test]
fn show_without_json_prints_the_blockers() {
    let home = Home::initialized();
    let task = home.new_ticket(&["task", "Renew the domain"]);
    let first = home.new_ticket(&["task", "Pay the bill"]);
    let second = home.new_ticket(&["task", "Find the card"]);

    for blocker in [&first, &second] {
        let block = home.tikk(&["block", &task, blocker]);
        assert_eq!(block.exit_code, 0, "block {blocker}: {}", block.stderr);
    }

    let run = home.tikk(&["show", &task]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(
        run.stdout,
        format!("{task}  task  open  -  Renew the domain\nblockedBy: {first}, {second}\n")
    );
}

#[test]
fn show_without_json_prints_one_line_per_question() {
    let home = Home::initialized();
    let task = home.new_ticket(&["task", "Renew the domain"]);
    let mut items = Vec::new();

    for text in ["Which registrar?", "How many years?"] {
        let run = home.tikk(&["ask", &task, "--text", text, "--json"]);
        assert_eq!(run.exit_code, 0, "ask {text}: {}", run.stderr);
        items.push(
            parse_json(&run.stdout)["item"]
                .as_str()
                .expect("ask prints the item")
                .to_owned(),
        );
    }

    let answer = home.tikk(&["answer", &task, &items[0], "--text", "The same one"]);
    let run = home.tikk(&["show", &task]);

    assert_eq!(answer.exit_code, 0, "answer: {}", answer.stderr);
    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(
        run.stdout,
        format!(
            "{task}  task  open  -  Renew the domain\nquestion {}: Which registrar? answer: The same one\nquestion {}: How many years? (open)\n",
            items[0], items[1]
        )
    );
}

#[test]
fn show_json_of_a_claimed_slice_with_a_shared_id_is_id_shared_and_names_both_paths() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();
    let claim = home.tikk_as("manager", &["claim", &slice]);
    assert_eq!(claim.exit_code, 0, "claim: {}", claim.stderr);
    let paths = home.share_id(&slice);

    let run = home.tikk(&["show", &slice, "--json"]);

    assert_eq!(run.exit_code, 1, "{}", run.stdout);
    assert_eq!(run.stdout, "", "no claim is shown");
    let error = &parse_json(&run.stderr)["error"];
    assert_eq!(error["code"], json!("idShared"), "{error}");
    assert_eq!(error["files"], json!(paths), "{error}");
}
