mod support;

use serde_json::json;

use support::{Home, parse_json};

#[test]
fn write_with_an_old_hash_after_a_hand_edit_is_refused_and_keeps_the_edit() {
    let home = Home::initialized();
    let id = home.new_ticket(&["task", "Renew the domain"]);
    let shown = home.show_json(&id);
    let path = shown["path"].as_str().expect("show prints the path");
    let old_hash = shown["hash"].as_str().expect("show prints the hash");
    let hand_edit = "---\nkind: task\ntitle: Renew the domain by hand\n---\nMine\n";
    std::fs::write(path, hand_edit).expect("edit the ticket file by hand");
    let agent_document = home.document(
        "agent.md",
        "---\nkind: task\ntitle: Renew the domain for two years\n---\n",
    );

    let run = home.tikk(&[
        "write",
        &id,
        "--file",
        agent_document.to_str().expect("a UTF-8 path"),
        "--hash",
        old_hash,
        "--json",
    ]);

    assert_eq!(run.exit_code, 1, "stdout: {}", run.stdout);
    assert_eq!(run.stdout, "");
    assert_eq!(
        parse_json(&run.stderr)["error"]["code"],
        json!("changedOnDisk")
    );
    assert_eq!(
        std::fs::read_to_string(path).expect("read the ticket file"),
        hand_edit
    );
}

fn every_field_slice(home: &Home) -> String {
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let blocker = home.new_ticket(&["task", "Decide the lease length", "--parent", &plan]);
    let document = home.document(
        "slice.md",
        &format!(
            "---\nkind: slice\ntitle: Lock the store\nstatus: canceled\nreason: Out of scope\nparent: {plan}\nrank: 2\nblockedBy: [{blocker}]\ndiscoveredFrom: {blocker}\nrelated: [{plan}]\ncriteria:\n  - id: c1\n    check: cargo nextest run\n    expected: passes\n---\nBody\n"
        ),
    );

    home.new_ticket(&["--file", document.to_str().expect("a UTF-8 path")])
}

fn write_document(home: &Home, id: &str, text: &str, hash: &str) -> support::Run {
    let document = home.document("written.md", text);

    home.tikk(&[
        "write",
        id,
        "--file",
        document.to_str().expect("a UTF-8 path"),
        "--hash",
        hash,
        "--json",
    ])
}

#[test]
fn write_of_the_shown_document_with_its_hash_keeps_the_file_bytes() {
    let home = Home::initialized();
    let slice = every_field_slice(&home);
    let shown = home.show_json(&slice);
    let path = shown["path"].as_str().expect("show prints the path");
    let before = std::fs::read(path).expect("read the ticket file");

    let run = write_document(
        &home,
        &slice,
        shown["document"]
            .as_str()
            .expect("show prints the document"),
        shown["hash"].as_str().expect("show prints the hash"),
    );

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(std::fs::read(path).expect("read the ticket file"), before);
    assert_eq!(parse_json(&run.stdout)["hash"], shown["hash"]);
}

#[test]
fn write_replaces_the_ticket_and_prints_the_new_hash() {
    let home = Home::initialized();
    let id = home.new_ticket(&["task", "Renew the domain"]);
    let shown = home.show_json(&id);
    let changed = "---\nkind: task\ntitle: Renew the domain for two years\n---\nBy May.\n";

    let run = write_document(
        &home,
        &id,
        changed,
        shown["hash"].as_str().expect("show prints the hash"),
    );

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    let written = parse_json(&run.stdout);
    let after = home.show_json(&id);
    assert_eq!(
        written,
        json!({
            "id": id,
            "title": "Renew the domain for two years",
            "kind": "task",
            "status": "open",
            "parent": null,
            "path": shown["path"],
            "hash": after["hash"],
        })
    );
    assert_eq!(
        after["document"],
        json!(
            "---\nkind: task\ntitle: Renew the domain for two years\nstatus: open\n---\nBy May.\n"
        )
    );
    assert_eq!(after["path"], shown["path"], "the file keeps its name");
}

#[test]
fn write_refuses_a_link_to_a_missing_ticket_and_keeps_the_file() {
    let home = Home::initialized();
    let id = home.new_ticket(&["task", "Renew the domain"]);
    let shown = home.show_json(&id);
    let path = shown["path"].as_str().expect("show prints the path");
    let before = std::fs::read(path).expect("read the ticket file");

    let run = write_document(
        &home,
        &id,
        "---\nkind: task\ntitle: Renew the domain\nblockedBy: [personal-wxyz]\n---\n",
        shown["hash"].as_str().expect("show prints the hash"),
    );

    assert_eq!(run.exit_code, 1, "stdout: {}", run.stdout);
    let error = &parse_json(&run.stderr)["error"];
    assert_eq!(error["code"], json!("invalidTicket"));
    assert_eq!(error["field"], json!("blockedBy"));
    assert_eq!(std::fs::read(path).expect("read the ticket file"), before);
}

#[test]
fn write_refuses_a_plan_rewritten_as_a_slice_under_itself_and_keeps_the_file() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let shown = home.show_json(&plan);
    let path = shown["path"].as_str().expect("show prints the path");
    let before = std::fs::read(path).expect("read the plan file");

    let run = write_document(
        &home,
        &plan,
        &format!("---\nkind: slice\ntitle: Self parent\nparent: {plan}\n---\n"),
        shown["hash"].as_str().expect("show prints the hash"),
    );

    assert_eq!(run.exit_code, 1, "stdout: {}", run.stdout);
    let error = &parse_json(&run.stderr)["error"];
    assert_eq!(error["code"], json!("invalidTicket"));
    assert_eq!(error["field"], json!("parent"));
    assert_eq!(std::fs::read(path).expect("read the plan file"), before);
}

#[test]
fn write_refuses_a_kind_that_its_children_cannot_sit_under_and_keeps_the_file() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    home.new_ticket(&["slice", "Lock the store", "--parent", &plan]);
    let shown = home.show_json(&plan);
    let path = shown["path"].as_str().expect("show prints the path");
    let before = std::fs::read(path).expect("read the plan file");

    let run = write_document(
        &home,
        &plan,
        "---\nkind: task\ntitle: Move to tikk\n---\n",
        shown["hash"].as_str().expect("show prints the hash"),
    );

    assert_eq!(run.exit_code, 1, "stdout: {}", run.stdout);
    let error = &parse_json(&run.stderr)["error"];
    assert_eq!(error["code"], json!("invalidTicket"));
    assert_eq!(error["field"], json!("kind"));
    assert_eq!(std::fs::read(path).expect("read the plan file"), before);
}

#[test]
fn write_of_an_unchanged_hand_formatted_document_keeps_the_file_bytes() {
    let home = Home::initialized();
    let id = home.new_ticket(&["task", "Renew the domain"]);
    let path = home.show_json(&id)["path"]
        .as_str()
        .expect("show prints the path")
        .to_owned();
    let hand_edit = "---\n# renew by May\ntitle: Renew the domain\nkind: task\n---\nNotes.\n";
    std::fs::write(&path, hand_edit).expect("edit the ticket file by hand");
    let shown = home.show_json(&id);

    let run = write_document(
        &home,
        &id,
        shown["document"]
            .as_str()
            .expect("show prints the document"),
        shown["hash"].as_str().expect("show prints the hash"),
    );

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(
        std::fs::read_to_string(&path).expect("read the ticket file"),
        hand_edit
    );
    assert_eq!(parse_json(&run.stdout)["hash"], shown["hash"]);
}

#[test]
fn write_without_a_hash_is_wrong_usage() {
    let home = Home::initialized();
    let id = home.new_ticket(&["task", "Renew the domain"]);
    let document = home.document("written.md", "---\nkind: task\ntitle: T\n---\n");

    let run = home.tikk(&[
        "write",
        &id,
        "--file",
        document.to_str().expect("a UTF-8 path"),
    ]);

    assert_eq!(run.exit_code, 2, "stderr: {}", run.stderr);
}
