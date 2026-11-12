mod support;

use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};

use serde_json::json;

use support::{Home, finish, parse_json};

fn recording_editor(home: &Home) -> (PathBuf, PathBuf) {
    let script = home.work().join("editor.sh");
    let record = home.work().join("editor-arguments.txt");

    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n",
            record.display()
        ),
    )
    .expect("write the editor script");
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
        .expect("make the editor script executable");

    (script, record)
}

fn edit_with(home: &Home, editor: &str, id: &str) -> support::Run {
    let mut command = home.command(&["edit", id, "--json"]);

    command.env("EDITOR", editor);

    finish(command.output().expect("start the tikk binary"))
}

fn ticket_path(home: &Home, id: &str) -> String {
    home.show_json(id)["path"]
        .as_str()
        .expect("show prints the path")
        .to_owned()
}

fn recorded(record: &Path) -> String {
    std::fs::read_to_string(record).expect("the editor ran and recorded its arguments")
}

#[test]
fn edit_runs_the_editor_script_with_the_ticket_file_path() {
    let home = Home::initialized();
    let id = home.new_ticket(&["task", "Renew the domain"]);
    let path = ticket_path(&home, &id);
    let before = std::fs::read(&path).expect("read the ticket file");
    let (script, record) = recording_editor(&home);

    let run = edit_with(&home, script.to_str().expect("a UTF-8 path"), &id);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(recorded(&record), format!("{path}\n"));
    assert_eq!(parse_json(&run.stdout), json!({ "id": id, "path": path }));
    assert_eq!(std::fs::read(&path).expect("read the ticket file"), before);
}

#[test]
fn edit_passes_the_arguments_in_editor_before_the_path() {
    let home = Home::initialized();
    let id = home.new_ticket(&["task", "Renew the domain"]);
    let path = ticket_path(&home, &id);
    let (script, record) = recording_editor(&home);
    let editor = format!("{} --wait", script.to_str().expect("a UTF-8 path"));

    let run = edit_with(&home, &editor, &id);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(recorded(&record), format!("--wait\n{path}\n"));
}

#[test]
fn edit_opens_a_file_that_does_not_parse() {
    let home = Home::initialized();
    let id = home.new_ticket(&["task", "Renew the domain"]);
    let path = ticket_path(&home, &id);
    std::fs::write(&path, "kind: [\n").expect("break the ticket file by hand");
    let (script, record) = recording_editor(&home);

    let run = edit_with(&home, script.to_str().expect("a UTF-8 path"), &id);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(recorded(&record), format!("{path}\n"));
}

#[test]
fn edit_refuses_a_missing_or_empty_editor_and_a_failing_one() {
    let home = Home::initialized();
    let id = home.new_ticket(&["task", "Renew the domain"]);

    let unset = home.tikk(&["edit", &id, "--json"]);
    let empty = edit_with(&home, "", &id);
    let failing = edit_with(&home, "false", &id);

    for (name, run, code) in [
        ("unset", unset, "noEditor"),
        ("empty", empty, "noEditor"),
        ("failing", failing, "editorFailed"),
    ] {
        assert_eq!(run.exit_code, 1, "case {name}: {}", run.stdout);
        assert_eq!(
            parse_json(&run.stderr)["error"]["code"],
            json!(code),
            "case {name}"
        );
    }
}
