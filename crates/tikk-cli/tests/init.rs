mod support;

use serde_json::{Value, json};

use support::Home;

fn parse_json(text: &str) -> Value {
    serde_json::from_str(text).expect("tikk prints one JSON value")
}

#[test]
fn init_json_creates_the_store_with_one_commit_on_main() {
    let home = Home::new();

    let run = home.tikk(&["init", "--json"]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(
        parse_json(&run.stdout),
        json!({ "store": home.store().to_str().expect("a UTF-8 path"), "created": true })
    );

    let config = std::fs::read_to_string(home.store().join("tikk.json")).expect("read tikk.json");
    assert_eq!(parse_json(&config), json!({ "version": 1 }));

    let attributes =
        std::fs::read_to_string(home.store().join(".gitattributes")).expect("read .gitattributes");
    assert!(
        attributes
            .lines()
            .any(|line| line == "facts/** merge=union")
    );

    assert_eq!(home.git(&["rev-list", "--count", "main"]).trim(), "1");
    assert_eq!(home.git(&["branch", "--show-current"]).trim(), "main");
    assert_eq!(home.git(&["status", "--porcelain"]), "");
}

#[test]
fn second_init_json_reports_the_store_was_not_created() {
    let home = Home::new();
    let first = home.tikk(&["init", "--json"]);
    assert_eq!(first.exit_code, 0, "stderr: {}", first.stderr);

    let second = home.tikk(&["init", "--json"]);

    assert_eq!(second.exit_code, 0, "stderr: {}", second.stderr);
    assert_eq!(parse_json(&second.stdout)["created"], json!(false));
    assert_eq!(home.git(&["rev-list", "--count", "main"]).trim(), "1");
}

#[test]
fn init_with_machine_saves_the_name_in_the_git_folder() {
    let home = Home::new();

    let run = home.tikk(&["init", "--machine", "laptop"]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    let machine = std::fs::read_to_string(home.store().join(".git/tikk-machine"))
        .expect("read the machine file");
    assert_eq!(machine.trim_end(), "laptop");
}

#[test]
fn init_without_machine_saves_the_first_label_of_the_host_name() {
    let home = Home::new();
    let uname = std::process::Command::new("uname")
        .arg("-n")
        .output()
        .expect("start uname");
    let host_name = String::from_utf8(uname.stdout).expect("uname prints UTF-8");
    let expected = host_name
        .trim()
        .split('.')
        .next()
        .expect("split yields a first label")
        .to_lowercase();

    let run = home.tikk(&["init", "--json"]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    let machine = std::fs::read_to_string(home.store().join(".git/tikk-machine"))
        .expect("read the machine file");
    assert_eq!(machine, format!("{expected}\n"));
}

#[test]
fn init_with_an_invalid_machine_name_is_wrong_usage() {
    let home = Home::new();

    let run = home.tikk(&["init", "--json", "--machine", "My Laptop"]);

    assert_eq!(run.exit_code, 2);
    assert_eq!(run.stdout, "");
    assert_eq!(
        parse_json(&run.stderr)["error"]["code"],
        json!("invalidArguments")
    );
    assert!(!home.store().join("tikk.json").exists());
}

#[test]
fn init_refuses_a_folder_with_other_files() {
    let home = Home::new();
    std::fs::write(home.store().join("notes.txt"), "mine").expect("write a file");

    let run = home.tikk(&["init", "--json"]);

    assert_eq!(run.exit_code, 1);
    assert_eq!(run.stdout, "");
    assert_eq!(
        parse_json(&run.stderr)["error"]["code"],
        json!("folderNotEmpty")
    );
    assert!(!home.store().join(".git").exists());
}

fn parent_git(parent: &std::path::Path, arguments: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(parent)
        .args(arguments)
        .env_remove("GIT_DIR")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .expect("start git");

    assert!(output.status.success(), "git {arguments:?} failed");

    String::from_utf8(output.stdout).expect("git prints UTF-8")
}

#[test]
fn init_with_a_relative_store_path_never_commits_a_parent_repository() {
    let home = Home::new();
    let parent = home.store();
    parent_git(&parent, &["init", "--quiet"]);
    std::fs::write(parent.join("unrelated.txt"), "parent work").expect("write a parent file");
    parent_git(&parent, &["add", "unrelated.txt"]);
    let candidate = parent.join("candidate");
    std::fs::create_dir_all(candidate.join(".git")).expect("create an empty .git folder");
    std::fs::write(candidate.join("tikk.json"), "{\"version\":1}\n").expect("write tikk.json");
    std::fs::write(candidate.join(".gitattributes"), "facts/** merge=union\n")
        .expect("write .gitattributes");

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_tikk"))
        .args(["init", "--json", "--machine", "laptop"])
        .current_dir(&parent)
        .env("TIKK_HOME", "candidate")
        .env_remove("GIT_DIR")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .expect("start the tikk binary");

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        parent_git(&parent, &["rev-list", "--all", "--count"]).trim(),
        "0"
    );
    assert_eq!(
        parent_git(&parent, &["diff", "--cached", "--name-only"]).trim(),
        "unrelated.txt"
    );
}
