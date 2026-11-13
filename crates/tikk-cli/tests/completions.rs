mod support;

use std::process::Command;

use serde_json::json;

use support::{Home, Run, finish, parse_json};

fn candidates(run: &Run) -> Vec<(String, String)> {
    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(run.stderr, "");

    let mut pairs: Vec<(String, String)> = run
        .stdout
        .lines()
        .filter(|line| !line.starts_with('-'))
        .map(|line| {
            let (value, help) = line.split_once('\t').unwrap_or((line, ""));

            (value.to_owned(), help.to_owned())
        })
        .collect();

    pairs.sort();

    pairs
}

fn pairs(entries: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = entries
        .iter()
        .map(|(id, title)| ((*id).to_owned(), (*title).to_owned()))
        .collect();

    pairs.sort();

    pairs
}

#[test]
fn a_blocker_completes_to_every_id_with_its_title() {
    let home = Home::initialized();
    let renew = home.new_ticket(&["task", "Renew the domain"]);
    let lock = home.new_ticket(&["task", "Lock the store"]);
    let plan = home.new_ticket(&["plan", "Move to tikk"]);

    let run = home.complete(&["block", &renew, ""]);

    assert_eq!(
        candidates(&run),
        pairs(&[
            (&renew, "Renew the domain"),
            (&lock, "Lock the store"),
            (&plan, "Move to tikk"),
        ])
    );
}

fn ids(run: &Run) -> Vec<String> {
    candidates(run).into_iter().map(|(id, _)| id).collect()
}

fn sorted(values: &[&str]) -> Vec<String> {
    let mut values: Vec<String> = values.iter().map(|value| (*value).to_owned()).collect();

    values.sort();

    values
}

#[test]
fn the_parent_of_a_moved_instruction_completes_to_slices_only() {
    let home = Home::initialized();
    let (plan, slice) = home.plan_and_slice();
    let other_slice = home.slice_under(&plan, "Add the lock", &[]);
    let instruction = home.new_ticket(&["instruction", "Write the lock", "--parent", &slice]);
    home.new_ticket(&["task", "Renew the domain"]);

    let run = home.complete(&["--json", "move", &instruction, "--parent", ""]);

    assert_eq!(ids(&run), sorted(&[&slice, &other_slice]));
}

#[test]
fn new_ls_and_ready_parents_complete_to_the_kinds_that_can_hold_the_ticket() {
    let home = Home::initialized();
    let (plan, slice) = home.plan_and_slice();
    let instruction = home.new_ticket(&["instruction", "Write the lock", "--parent", &slice]);
    let task = home.new_ticket(&["task", "Renew the domain"]);
    let cases: [(&[&str], Vec<String>); 5] = [
        (
            &["new", "instruction", "Write", "--parent", ""],
            sorted(&[&slice]),
        ),
        (&["new", "task", "Renew", "--parent", ""], sorted(&[&plan])),
        (
            &["new", "--parent", ""],
            sorted(&[&plan, &slice, &instruction, &task]),
        ),
        (&["ls", "--parent", ""], sorted(&[&plan, &slice])),
        (&["ready", "--parent", ""], sorted(&[&plan, &slice])),
    ];

    for (words, expected) in cases {
        assert_eq!(ids(&home.complete(words)), expected, "case {words:?}");
    }
}

#[test]
fn a_rank_anchor_completes_to_the_subject_siblings_only() {
    let home = Home::initialized();
    let (plan, slice) = home.plan_and_slice();
    let second = home.slice_under(&plan, "Add the lock", &[]);
    let third = home.slice_under(&plan, "Add the sync", &[]);
    let other_plan = home.new_ticket(&["plan", "Ship the app"]);
    home.slice_under(&other_plan, "Draw the board", &[]);
    home.new_ticket(&["task", "Renew the domain"]);

    let before = home.complete(&["rank", &slice, "--before", ""]);
    let after = home.complete(&["rank", &slice, "--after", ""]);

    assert_eq!(ids(&before), sorted(&[&second, &third]));
    assert_eq!(ids(&after), sorted(&[&second, &third]));
}

#[test]
fn an_unknown_subject_offers_every_id() {
    let home = Home::initialized();
    let (plan, slice) = home.plan_and_slice();

    let run = home.complete(&["move", "personal-zzzz", "--parent", ""]);

    assert_eq!(ids(&run), sorted(&[&plan, &slice]));
}

#[test]
fn every_ticket_id_argument_completes_to_the_ids_and_an_item_does_not() {
    let home = Home::initialized();
    let id = home.new_ticket(&["task", "Renew the domain"]);
    let with_ids: [&[&str]; 21] = [
        &["show", ""],
        &["edit", ""],
        &["write", ""],
        &["block", ""],
        &["block", &id, ""],
        &["unblock", ""],
        &["unblock", &id, ""],
        &["move", ""],
        &["move", "--parent", ""],
        &["rank", ""],
        &["rank", "--before", ""],
        &["done", ""],
        &["cancel", ""],
        &["claim", ""],
        &["release", ""],
        &["ask", ""],
        &["answer", ""],
        &["pr", "link", ""],
        &["pr", "refresh", ""],
        &["audit", ""],
        &["new", "--parent", ""],
    ];
    let without_ids: [&[&str]; 2] = [&["answer", &id, ""], &["ls", "--search", ""]];

    for words in with_ids {
        let run = home.complete(words);

        assert_eq!(
            candidates(&run),
            vec![(id.clone(), "Renew the domain".to_owned())],
            "case {words:?}"
        );
    }

    for words in without_ids {
        let run = home.complete(words);

        assert_eq!(candidates(&run), Vec::new(), "case {words:?}");
    }
}

#[test]
fn a_broken_ticket_file_leaves_the_other_ids() {
    let home = Home::initialized();
    let renew = home.new_ticket(&["task", "Renew the domain"]);
    let broken = home.new_ticket(&["task", "Lock the store"]);
    let plan = home.new_ticket(&["plan", "Move to tikk"]);
    std::fs::write(
        home.store()
            .join(format!("tickets/personal/{broken}-lock-the-store.md")),
        "---\nkind: task\ntitle: [Lock the store\n---\n",
    )
    .expect("break the ticket file");

    let run = home.complete(&["show", ""]);

    assert_eq!(ids(&run), sorted(&[&renew, &plan]));
}

#[test]
fn completion_writes_nothing_and_creates_no_lock_file() {
    let home = Home::initialized();
    let renew = home.new_ticket(&["task", "Renew the domain"]);
    let (_, slice) = home.plan_and_slice();
    home.sync_json();
    let lock = home.store().join(".git/tikk.lock");
    let saved_sync = home.store().join(".git/tikk-sync.json");
    std::fs::remove_file(&lock).expect("remove the lock file");
    let files = home.store_files();
    let facts = home.fact_lines();
    let sync = std::fs::read(&saved_sync).expect("read the saved sync result");

    for words in [
        &["block", renew.as_str(), ""][..],
        &["rank", slice.as_str(), "--after", ""][..],
        &["claim", ""][..],
    ] {
        let run = home.complete(words);

        assert_eq!(run.exit_code, 0, "case {words:?}: {}", run.stderr);
    }

    assert_eq!(home.store_files(), files);
    assert_eq!(home.fact_lines(), facts);
    assert_eq!(
        std::fs::read(&saved_sync).expect("read the saved sync result"),
        sync
    );
    assert!(!lock.exists(), "completion created {}", lock.display());
}

#[test]
fn completion_answers_while_another_process_holds_the_store_lock() {
    let home = Home::initialized();
    let renew = home.new_ticket(&["task", "Renew the domain"]);
    let holder = home.lock_file();
    holder.lock().expect("take the exclusive lock");

    let run = home.complete(&["show", ""]);

    assert_eq!(
        candidates(&run),
        vec![(renew, "Renew the domain".to_owned())]
    );
    holder.unlock().expect("release the lock");
}

#[test]
fn a_store_that_is_missing_or_unreadable_gives_no_candidate_and_exit_0() {
    let missing = Home::new();
    let unreadable = Home::initialized();
    unreadable.new_ticket(&["task", "Renew the domain"]);
    let tickets = unreadable.store().join("tickets");
    std::fs::remove_dir_all(&tickets).expect("remove the tickets folder");
    std::fs::write(&tickets, "not a folder").expect("put a file in its place");
    let broken_config = Home::initialized();
    std::fs::write(broken_config.store().join("tikk.json"), "{").expect("break the config");

    for (name, home) in [
        ("missing", &missing),
        ("unreadable", &unreadable),
        ("broken config", &broken_config),
    ] {
        let run = home.complete(&["show", ""]);

        assert_eq!(run.exit_code, 0, "{name}: {}", run.stderr);
        assert_eq!(run.stderr, "", "{name}");
        assert_eq!(candidates(&run), Vec::new(), "{name}");
    }
}

#[test]
fn commands_complete_without_a_store() {
    let home = Home::new();

    let run = home.complete(&["sh"]);

    assert_eq!(
        candidates(&run),
        vec![(
            "show".to_owned(),
            "Show a ticket with its body, children, and folder files".to_owned()
        )]
    );
}

#[expect(
    clippy::print_stderr,
    reason = "a test that skips a shell names the reason in its output"
)]
fn check_syntax(shell: &str, script: &std::path::Path) {
    let output = match Command::new(shell).arg("-n").arg(script).output() {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("skipped: {shell} is not installed");

            return;
        }
        Err(error) => panic!("start {shell}: {error}"),
    };

    assert!(
        output.status.success(),
        "{shell} -n: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn each_completion_script_passes_the_syntax_check_of_its_shell() {
    let home = Home::new();

    for shell in ["bash", "zsh", "fish"] {
        let run = home.tikk(&["completions", shell]);

        assert_eq!(run.exit_code, 0, "{shell}: {}", run.stderr);
        assert_eq!(run.stderr, "", "{shell}");
        assert!(run.stdout.contains("COMPLETE="), "{shell}: {}", run.stdout);
        let script = home.document(&format!("tikk.{shell}"), &run.stdout);
        check_syntax(shell, &script);
    }
}

#[test]
fn the_script_is_the_registration_that_complete_prints() {
    let home = Home::new();

    for shell in ["bash", "zsh", "fish"] {
        let run = home.tikk(&["completions", shell]);
        let registration = finish(
            home.command(&[])
                .env("COMPLETE", shell)
                .output()
                .expect("start the tikk binary"),
        );

        assert_eq!(
            registration.exit_code, 0,
            "{shell}: {}",
            registration.stderr
        );
        assert_eq!(run.stdout, registration.stdout, "{shell}");
    }
}

#[test]
fn completions_with_json_prints_the_script_in_an_object() {
    let home = Home::new();
    let text = home.tikk(&["completions", "zsh"]);

    let run = home.tikk(&["completions", "zsh", "--json"]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(parse_json(&run.stdout), json!({ "script": text.stdout }));
}

#[test]
fn completions_without_a_shell_is_wrong_usage() {
    let home = Home::new();

    let run = home.tikk(&["completions", "--json"]);

    assert_eq!(run.exit_code, 2, "stdout: {}", run.stdout);
    assert_eq!(run.stdout, "");
    assert_eq!(
        parse_json(&run.stderr)["error"]["code"],
        json!("invalidArguments")
    );
}

#[test]
fn completions_help_says_how_to_load_the_script_in_each_shell() {
    let home = Home::new();

    let run = home.tikk(&["completions", "--help"]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    for line in [
        "source <(tikk completions bash)",
        "source <(tikk completions zsh)",
        "tikk completions fish | source",
    ] {
        assert!(run.stdout.contains(line), "{line}: {}", run.stdout);
    }
}

#[test]
fn bash_receives_the_ids_without_titles() {
    let home = Home::initialized();
    let renew = home.new_ticket(&["task", "Renew the domain"]);
    let lock = home.new_ticket(&["task", "Lock the store"]);

    let run = finish(
        home.command(&["--", "tikk", "block", &renew, ""])
            .env("COMPLETE", "bash")
            .env("_CLAP_COMPLETE_INDEX", "3")
            .env("_CLAP_IFS", "\n")
            .output()
            .expect("start the tikk binary"),
    );

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    let mut offered: Vec<&str> = run
        .stdout
        .lines()
        .filter(|line| !line.starts_with('-'))
        .collect();
    offered.sort_unstable();
    assert_eq!(offered, sorted(&[&renew, &lock]));
}
