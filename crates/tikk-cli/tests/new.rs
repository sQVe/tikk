mod support;

use std::path::Path;

use serde_json::json;

use support::{Home, parse_json, run_git};

fn repository_with_origin(directory: &Path, url: &str) {
    std::fs::create_dir_all(directory).expect("create the repository folder");
    run_git(directory, &["init", "--quiet"]);
    run_git(directory, &["remote", "add", "origin", url]);
}

#[test]
fn new_prints_the_new_id_and_writes_the_ticket_file() {
    let home = Home::initialized();

    let run = home.tikk(&["new", "task", "Renew the domain"]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    let id = run.stdout.trim_end();
    assert!(id.starts_with("personal-"), "{id}");
    let files = home.ticket_files();
    assert_eq!(
        files,
        [home
            .store()
            .join(format!("tickets/personal/{id}-renew-the-domain.md"))]
    );
    assert_eq!(
        std::fs::read_to_string(&files[0]).expect("read the ticket"),
        "---\nkind: task\ntitle: Renew the domain\nstatus: open\n---\n"
    );
    assert_eq!(home.git(&["rev-list", "--count", "main"]).trim(), "1");
}

#[test]
fn new_file_with_a_task_under_a_slice_names_the_parent_field_and_writes_nothing() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let slice = home.new_ticket(&["slice", "Add ticket files", "--parent", &plan]);
    let document = home.document(
        "task.md",
        &format!("---\nkind: task\ntitle: Write a note\nparent: {slice}\n---\n"),
    );
    let before = home.ticket_files();

    let run = home.tikk(&[
        "new",
        "--json",
        "--file",
        document.to_str().expect("a UTF-8 path"),
    ]);

    assert_eq!(run.exit_code, 1);
    assert_eq!(run.stdout, "");
    let error = parse_json(&run.stderr);
    assert_eq!(error["error"]["code"], json!("invalidTicket"));
    assert_eq!(error["error"]["field"], json!("parent"));
    assert_eq!(home.ticket_files(), before);
}

#[test]
fn new_slice_with_a_parent_takes_the_plan_project_from_another_repository() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk", "--project", "tikk"]);
    let other = home.work().join("other");
    repository_with_origin(&other, "git@github.com:owner/other.git");

    let created = home.tikk_in(
        &other,
        &["new", "slice", "Add files", "--parent", &plan, "--json"],
    );
    let refused = home.tikk_in(
        &other,
        &[
            "new",
            "slice",
            "Add more",
            "--parent",
            &plan,
            "--project",
            "other",
            "--json",
        ],
    );

    assert_eq!(created.exit_code, 0, "stderr: {}", created.stderr);
    let slice = parse_json(&created.stdout)["id"]
        .as_str()
        .expect("new prints the ID")
        .to_owned();
    assert!(slice.starts_with("tikk-"), "{slice}");
    assert_eq!(refused.exit_code, 1);
    let error = parse_json(&refused.stderr);
    assert_eq!(error["error"]["code"], json!("invalidTicket"));
    assert_eq!(error["error"]["field"], json!("project"));
    assert_eq!(home.ticket_files().len(), 2);
}

#[test]
fn new_without_a_parent_takes_the_project_from_origin_in_a_subfolder() {
    let home = Home::initialized();
    let repository = home.work().join("repository");
    repository_with_origin(&repository, "https://github.com/owner/My-App.git");
    let subfolder = repository.join("src");
    std::fs::create_dir(&subfolder).expect("create a subfolder");

    let run = home.tikk_in(&subfolder, &["new", "plan", "Ship it", "--json"]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    let id = parse_json(&run.stdout)["id"]
        .as_str()
        .expect("new prints the ID")
        .to_owned();
    assert!(id.starts_with("my-app-"), "{id}");
}

#[test]
fn new_file_with_a_broken_document_is_a_parse_error() {
    let home = Home::initialized();
    let document = home.document("broken.md", "kind: task\ntitle: No fences\n");

    let run = home.tikk(&[
        "new",
        "--json",
        "--file",
        document.to_str().expect("a UTF-8 path"),
    ]);

    assert_eq!(run.exit_code, 1);
    assert_eq!(
        parse_json(&run.stderr)["error"]["code"],
        json!("parseError")
    );
    assert!(home.ticket_files().is_empty());
}

#[test]
fn new_with_wrong_arguments_is_wrong_usage() {
    let home = Home::initialized();
    let cases: [&[&str]; 4] = [
        &["new", "epic", "A title", "--json"],
        &["new", "task", "--json"],
        &["new", "task", "A title", "--file", "task.md", "--json"],
        &["new", "task", "A title", "--parent", "nope", "--json"],
    ];

    for arguments in cases {
        let run = home.tikk(arguments);

        assert_eq!(run.exit_code, 2, "case {arguments:?}");
        assert_eq!(
            parse_json(&run.stderr)["error"]["code"],
            json!("invalidArguments"),
            "case {arguments:?}"
        );
    }

    assert!(home.ticket_files().is_empty());
}

#[test]
fn new_on_a_missing_store_is_not_initialized() {
    let home = Home::new();

    let run = home.tikk(&["new", "task", "A title", "--json"]);

    assert_eq!(run.exit_code, 1);
    assert_eq!(
        parse_json(&run.stderr)["error"]["code"],
        json!("notInitialized")
    );
}
