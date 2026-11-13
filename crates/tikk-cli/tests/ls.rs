mod support;

use std::time::Instant;

use serde_json::{Value, json};

use support::{Home, parse_json};

fn listed_ids(run_stdout: &str) -> Vec<String> {
    let listing = parse_json(run_stdout);

    listing["tickets"]
        .as_array()
        .expect("ls lists tickets")
        .iter()
        .map(|ticket| ticket["id"].as_str().expect("a row has an ID").to_owned())
        .collect()
}

fn sorted(mut ids: Vec<String>) -> Vec<String> {
    ids.sort();

    ids
}

#[test]
fn ls_search_matches_title_or_body_without_case_and_status_keeps_canceled() {
    let home = Home::initialized();
    let title = home.new_ticket(&["task", "Lock the store"]);
    let body_document = home.document(
        "body.md",
        "---\nkind: task\ntitle: Write the import note\n---\nTake the lock first.\n",
    );
    let body = home.new_ticket(&["--file", body_document.to_str().expect("a UTF-8 path")]);
    let canceled_document = home.document(
        "canceled.md",
        "---\nkind: task\ntitle: Ask about Windows\nstatus: canceled\nreason: Linux and macOS only\n---\n",
    );
    let canceled = home.new_ticket(&["--file", canceled_document.to_str().expect("a UTF-8 path")]);
    home.new_ticket(&["task", "Decide the lease length"]);

    let search = home.tikk(&["ls", "--search", "lock", "--json"]);
    let status = home.tikk(&["ls", "--status", "canceled", "--json"]);

    assert_eq!(search.exit_code, 0, "stderr: {}", search.stderr);
    assert_eq!(listed_ids(&search.stdout), sorted(vec![title, body]));
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert_eq!(listed_ids(&status.stdout), vec![canceled]);
}

#[test]
fn ls_json_rows_hold_id_title_kind_status_and_parent() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let task = home.new_ticket(&["task", "Ask about Windows", "--parent", &plan]);

    let run = home.tikk(&["ls", "--parent", &plan, "--json"]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(
        parse_json(&run.stdout),
        json!({
            "tickets": [{
                "id": task,
                "title": "Ask about Windows",
                "kind": "task",
                "status": "open",
                "parent": plan,
            }],
            "errors": [],
        })
    );
}

#[test]
fn ls_filters_by_project_and_kind() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk", "--project", "tikk"]);
    home.new_ticket(&["task", "Renew the domain"]);
    home.new_ticket(&["task", "Lock the store", "--parent", &plan]);

    let by_project = home.tikk(&["ls", "--project", "tikk", "--kind", "plan", "--json"]);

    assert_eq!(by_project.exit_code, 0, "stderr: {}", by_project.stderr);
    assert_eq!(listed_ids(&by_project.stdout), vec![plan]);
}

#[test]
fn a_hand_broken_ticket_is_listed_under_errors_and_show_is_a_parse_error() {
    let home = Home::initialized();
    let good = home.new_ticket(&["task", "Renew the domain"]);
    let broken = home.new_ticket(&["task", "Lock the store"]);
    let path = home
        .store()
        .join(format!("tickets/personal/{broken}-lock-the-store.md"));
    std::fs::write(&path, "---\nkind: task\ntitle: [Lock the store\n---\n").expect("break it");

    let listing = home.tikk(&["ls", "--json"]);
    let show = home.tikk(&["show", &broken, "--json"]);

    assert_eq!(listing.exit_code, 0, "stderr: {}", listing.stderr);
    assert_eq!(listed_ids(&listing.stdout), vec![good]);
    let errors = &parse_json(&listing.stdout)["errors"];
    assert_eq!(errors.as_array().map(Vec::len), Some(1), "{errors}");
    assert_eq!(
        errors[0]["path"],
        json!(path.to_str().expect("a UTF-8 path"))
    );
    assert!(errors[0]["message"].is_string(), "{errors}");
    assert_eq!(show.exit_code, 1);
    assert_eq!(show.stdout, "");
    assert_eq!(
        parse_json(&show.stderr)["error"]["code"],
        json!("parseError")
    );
}

#[test]
fn ls_and_show_read_a_hand_edited_task_under_a_slice() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    let slice = home.new_ticket(&["slice", "Add ticket files", "--parent", &plan]);
    let task = home.new_ticket(&["task", "Write a note"]);
    let path = home
        .store()
        .join(format!("tickets/personal/{task}-write-a-note.md"));
    std::fs::write(
        &path,
        format!("---\nkind: task\ntitle: Write a note\nparent: {slice}\n---\n"),
    )
    .expect("move the task under the slice by hand");

    let listing = home.tikk(&["ls", "--parent", &slice, "--json"]);
    let show = home.tikk(&["show", &task, "--json"]);

    assert_eq!(listing.exit_code, 0, "stderr: {}", listing.stderr);
    let listed = parse_json(&listing.stdout);
    assert_eq!(listed["errors"], json!([]));
    assert_eq!(listed["tickets"][0]["id"], json!(task));
    assert_eq!(show.exit_code, 0, "stderr: {}", show.stderr);
    assert_eq!(parse_json(&show.stdout)["parent"], json!(slice));
}

#[test]
fn a_ticket_file_with_invalid_utf8_is_listed_under_errors_and_show_refuses_it() {
    let home = Home::initialized();
    let good = home.new_ticket(&["task", "Renew the domain"]);
    let broken = home.new_ticket(&["task", "Lock the store"]);
    let path = home
        .store()
        .join(format!("tickets/personal/{broken}-lock-the-store.md"));
    std::fs::write(&path, b"---\nkind: task\ntitle: \xff\xfe\n---\n").expect("write bad bytes");

    let listing = home.tikk(&["ls", "--json"]);
    let show = home.tikk(&["show", &broken, "--json"]);

    assert_eq!(listing.exit_code, 0, "stderr: {}", listing.stderr);
    assert_eq!(listed_ids(&listing.stdout), vec![good]);
    let errors = &parse_json(&listing.stdout)["errors"];
    assert_eq!(errors.as_array().map(Vec::len), Some(1), "{errors}");
    assert_eq!(
        errors[0]["path"],
        json!(path.to_str().expect("a UTF-8 path"))
    );
    assert_eq!(show.exit_code, 1);
    assert_eq!(show.stdout, "");
    assert_eq!(
        parse_json(&show.stderr)["error"]["code"],
        json!("parseError")
    );
}

#[test]
fn ls_json_on_a_missing_store_is_not_initialized() {
    let home = Home::new();

    let run = home.tikk(&["ls", "--json"]);

    assert_eq!(run.exit_code, 1);
    assert_eq!(run.stdout, "");
    assert_eq!(
        parse_json(&run.stderr)["error"]["code"],
        json!("notInitialized")
    );
}

#[test]
fn ls_without_json_prints_a_row_per_ticket() {
    let home = Home::initialized();
    let plan = home.new_ticket(&["plan", "Move to tikk"]);

    let run = home.tikk(&["ls"]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(run.stdout, format!("{plan}  plan  open  -  Move to tikk\n"));
}

#[test]
#[expect(
    clippy::print_stderr,
    reason = "the test reports the measured time for the slice record"
)]
fn ls_json_of_two_thousand_tickets_reports_its_time() {
    let home = Home::initialized();
    let alphabet: Vec<char> = "346789abcdefghijkmnpqrtwxyz".chars().collect();
    let folder = home.store().join("tickets/personal");
    std::fs::create_dir_all(&folder).expect("create the project folder");

    for index in 0..2_000 {
        let code: String = [index / 729, index / 27 % 27, index % 27, 0]
            .iter()
            .map(|digit| alphabet[*digit])
            .collect();
        let text = format!(
            "---\nkind: task\ntitle: Ticket {index}\nstatus: open\n---\nThe body of ticket {index}.\n"
        );

        std::fs::write(
            folder.join(format!("personal-{code}-ticket-{index}.md")),
            text,
        )
        .expect("write a ticket");
    }

    let started = Instant::now();
    let run = home.tikk(&["ls", "--json"]);
    let elapsed = started.elapsed();

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    let listing: Value = parse_json(&run.stdout);
    assert_eq!(listing["tickets"].as_array().map(Vec::len), Some(2_000));
    eprintln!(
        "tikk ls --json with 2,000 tickets took {} ms",
        elapsed.as_millis()
    );
}

#[test]
fn ls_json_lists_a_shared_id_under_errors_with_both_paths() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();
    let paths = home.share_id(&slice);

    let run = home.tikk(&["ls", "--json"]);

    assert_eq!(run.exit_code, 0, "{}", run.stderr);
    let errors = parse_json(&run.stdout)["errors"].clone();
    let clashes: Vec<&Value> = errors
        .as_array()
        .expect("ls lists errors")
        .iter()
        .filter(|error| error["code"] == json!("idShared"))
        .collect();
    assert_eq!(clashes.len(), 1, "{errors}");
    assert_eq!(clashes[0]["id"], json!(slice));
    assert_eq!(clashes[0]["paths"], json!(paths));
    let text = home.tikk(&["ls"]).stdout;
    assert!(
        text.contains(&format!(
            "error: {}: 2 files share the ID {slice}.",
            paths.join("  ")
        )),
        "{text}"
    );
}
