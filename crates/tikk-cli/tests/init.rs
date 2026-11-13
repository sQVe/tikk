mod support;

use serde_json::json;

use support::{Home, parse_json};

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

#[test]
fn init_through_a_symlink_to_an_empty_folder_creates_the_store_in_the_target() {
    let home = Home::new();
    let link = home.work().join("store-link");
    std::os::unix::fs::symlink(home.store(), &link).expect("link to the store folder");

    let run = home.tikk_with_environment(
        &home.work(),
        &[("TIKK_HOME", &link)],
        &["init", "--json", "--machine", "test"],
    );

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(parse_json(&run.stdout)["created"], json!(true));
    assert!(home.store().join(".git").is_dir());
    assert!(home.store().join("tikk.json").is_file());
    assert!(
        std::fs::symlink_metadata(&link)
            .expect("read the link")
            .file_type()
            .is_symlink()
    );
    for folder in [home.work(), home.store().join("..")] {
        let staging: Vec<_> = std::fs::read_dir(&folder)
            .expect("list a folder")
            .map(|entry| entry.expect("read an entry").file_name())
            .filter(|name| name.to_string_lossy().contains("tikk-init"))
            .collect();

        assert_eq!(staging, Vec::<std::ffi::OsString>::new(), "{folder:?}");
    }
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

#[test]
fn init_runs_no_post_commit_hook_from_the_global_git_config() {
    use std::os::unix::fs::PermissionsExt as _;

    let home = Home::new();
    let setup = tempfile::tempdir().expect("create a temporary directory");
    let hooks = setup.path().join("hooks");
    let marker = setup.path().join("hook-ran");
    std::fs::create_dir(&hooks).expect("create the hooks folder");
    let hook = hooks.join("post-commit");
    std::fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.display()))
        .expect("write the hook");
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755))
        .expect("make the hook executable");
    let global_config = setup.path().join("gitconfig");
    std::fs::write(
        &global_config,
        format!("[core]\n\thooksPath = {}\n", hooks.display()),
    )
    .expect("write the global Git config");

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_tikk"))
        .args(["init", "--json", "--machine", "laptop"])
        .env("TIKK_HOME", home.store())
        .env("GIT_CONFIG_GLOBAL", &global_config)
        .env_remove("GIT_DIR")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .expect("start the tikk binary");

    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(home.git(&["rev-list", "--count", "main"]).trim(), "1");
    assert!(!marker.exists(), "the post-commit hook ran");
}

#[test]
fn two_inits_at_once_on_one_empty_store_both_succeed_with_one_commit() {
    for round in 0..5 {
        let home = Home::new();
        let children: Vec<_> = (0..2)
            .map(|_| {
                home.command(&["init", "--json", "--machine", "test"])
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .expect("start the tikk binary")
            })
            .collect();
        let runs: Vec<_> = children
            .into_iter()
            .map(|child| support::finish(child.wait_with_output().expect("wait for tikk")))
            .collect();

        for run in &runs {
            assert_eq!(run.exit_code, 0, "round {round}: {}", run.stderr);
        }
        let created = runs
            .iter()
            .filter(|run| parse_json(&run.stdout)["created"] == json!(true))
            .count();
        assert_eq!(created, 1, "round {round}");
        assert_eq!(
            home.git(&["rev-list", "--count", "main"]).trim(),
            "1",
            "round {round}"
        );
    }
}

#[test]
fn a_second_init_on_a_store_path_that_is_not_utf8_reports_the_store_exists() {
    use std::os::unix::ffi::OsStrExt as _;

    let home = Home::new();
    let store = home.work().join(std::ffi::OsStr::from_bytes(b"store-\xff"));

    if !support::create_folder_unless_name_refused(&store) {
        return;
    }

    let init = || {
        let mut command = home.command(&["init", "--json", "--machine", "test"]);

        command.env("TIKK_HOME", &store);

        support::finish(command.output().expect("start the tikk binary"))
    };

    let first = init();
    let second = init();

    assert_eq!(first.exit_code, 0, "first: {}", first.stderr);
    assert_eq!(parse_json(&first.stdout)["created"], json!(true));
    assert_eq!(second.exit_code, 0, "second: {}", second.stderr);
    assert_eq!(parse_json(&second.stdout)["created"], json!(false));
}

fn host_machine_name() -> String {
    let uname = std::process::Command::new("uname")
        .arg("-n")
        .output()
        .expect("start uname");
    let host_name = String::from_utf8(uname.stdout).expect("uname prints UTF-8");

    host_name
        .trim()
        .split('.')
        .next()
        .expect("split yields a first label")
        .to_lowercase()
}

#[test]
fn init_remote_on_a_remote_with_this_host_machine_folder_asks_for_machine() {
    let remote = support::Remote::new();
    let laptop = Home::on_remote(&remote, &host_machine_name());
    laptop.append_machine_fact_line(
        &host_machine_name(),
        "2026-11.jsonl",
        "{\"v\":1,\"kind\":\"release\",\"ticket\":\"personal-abcd\",\"at\":\"2026-11-13T01:00:00Z\",\"agent\":null}",
    );
    assert_eq!(laptop.sync_json()["pushed"], json!(true));
    let desktop = Home::new();

    let refused = desktop.tikk(&["init", "--remote", &remote.url(), "--json"]);
    let chosen = desktop.tikk(&[
        "init",
        "--remote",
        &remote.url(),
        "--machine",
        "desktop",
        "--json",
    ]);

    assert_eq!(refused.exit_code, 1, "{}", refused.stderr);
    assert_eq!(refused.stdout, "");
    let error = &parse_json(&refused.stderr)["error"];
    assert_eq!(error["code"], json!("machineInUse"));
    assert!(
        error["message"].as_str().is_some_and(|message| message
            .contains(&format!("facts/{}/", host_machine_name()))
            && message.contains("--machine")),
        "{error}"
    );
    assert_eq!(chosen.exit_code, 0, "{}", chosen.stderr);
    assert_eq!(parse_json(&chosen.stdout)["created"], json!(true));
    assert_eq!(
        std::fs::read_to_string(desktop.store().join(".git/tikk-machine"))
            .expect("read the machine file"),
        "desktop\n"
    );
    assert_eq!(desktop.fact_lines(), laptop.fact_lines());
}

#[test]
fn init_remote_on_an_existing_store_reports_it_and_adds_no_remote() {
    let remote = support::Remote::new();
    let home = Home::initialized();

    let run = home.tikk(&["init", "--remote", &remote.url(), "--json"]);

    assert_eq!(run.exit_code, 0, "{}", run.stderr);
    assert_eq!(parse_json(&run.stdout)["created"], json!(false));
    assert_eq!(home.git(&["remote"]), "");
    assert_eq!(remote.git(&["for-each-ref"]), "");
}

#[test]
fn init_remote_on_a_remote_without_main_exits_with_1() {
    let remote = support::Remote::new();
    let other = Home::initialized();
    support::run_git(
        &other.store(),
        &["push", "--quiet", &remote.url(), "main:work"],
    );
    let home = Home::new();

    let run = home.tikk(&["init", "--remote", &remote.url(), "--json"]);

    assert_eq!(run.exit_code, 1, "{}", run.stderr);
    assert_eq!(
        parse_json(&run.stderr)["error"]["code"],
        json!("remoteWithoutMain")
    );
    assert!(!home.store().join("tikk.json").exists());
}
