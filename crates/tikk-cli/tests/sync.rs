mod support;

use std::os::unix::fs::PermissionsExt as _;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Barrier};
use std::thread;

use serde_json::{Value, json};

use support::{Home, Remote, finish, parse_json};

fn release_line(ticket: &str, at: &str) -> String {
    format!(
        "{{\"v\":1,\"kind\":\"release\",\"ticket\":\"{ticket}\",\"at\":\"{at}\",\"agent\":null}}"
    )
}

fn ticket_path(home: &Home, id: &str) -> std::path::PathBuf {
    let shown = home.show_json(id);

    std::path::PathBuf::from(shown["path"].as_str().expect("show prints the path"))
}

fn relative(home: &Home, path: &std::path::Path) -> String {
    path.strip_prefix(home.store())
        .expect("inside the store")
        .to_str()
        .expect("a UTF-8 path")
        .to_owned()
}

#[test]
fn a_ticket_made_on_one_store_is_listed_on_the_other_after_both_sync() {
    let remote = Remote::new();
    let laptop = Home::on_remote(&remote, "laptop");
    let desktop = Home::on_remote(&remote, "desktop");
    let id = laptop.new_ticket(&["task", "Renew the domain"]);

    let first = laptop.sync_json();
    let second = desktop.sync_json();

    assert_eq!(first["committed"], json!(true), "{first}");
    assert_eq!(first["pushed"], json!(true), "{first}");
    assert_eq!(second["merged"], json!(true), "{second}");
    assert_eq!(desktop.listed_ids(), vec![id]);
}

#[test]
fn two_stores_reach_the_same_tickets_and_fact_lines() {
    let remote = Remote::new();
    let laptop = Home::on_remote(&remote, "laptop");
    let desktop = Home::on_remote(&remote, "desktop");
    let laptop_ticket = laptop.new_ticket(&["task", "Renew the domain"]);
    let desktop_ticket = desktop.new_ticket(&["task", "Back up the mail"]);
    laptop.append_machine_fact_line(
        "laptop",
        "2026-11.jsonl",
        &release_line(&laptop_ticket, "2026-11-13T01:00:00Z"),
    );
    desktop.append_machine_fact_line(
        "desktop",
        "2026-11.jsonl",
        &release_line(&desktop_ticket, "2026-11-13T02:00:00Z"),
    );
    laptop.settle_files();
    desktop.settle_files();

    let first = laptop.sync_json();
    let second = desktop.sync_json();
    let third = laptop.sync_json();

    assert_eq!(first["committed"], json!(true), "{first}");
    assert_eq!(second["merged"], json!(true), "{second}");
    assert_eq!(third["merged"], json!(true), "{third}");
    assert_eq!(laptop.store_files(), desktop.store_files());
    assert_eq!(laptop.fact_lines().len(), 2);
    assert_eq!(laptop.fact_lines(), desktop.fact_lines());
    let mut both = vec![laptop_ticket, desktop_ticket];
    both.sort();
    assert_eq!(laptop.listed_ids(), both);
    assert_eq!(laptop.git(&["status", "--porcelain"]), "");
    assert_eq!(desktop.git(&["status", "--porcelain"]), "");
}

#[test]
fn appends_to_one_fact_file_on_two_machines_merge_without_a_conflict() {
    let remote = Remote::new();
    let laptop = Home::on_remote(&remote, "laptop");
    let desktop = Home::on_remote(&remote, "desktop");
    let first = release_line("personal-aaaa", "2026-11-13T01:00:00Z");
    laptop.append_machine_fact_line("shared", "2026-11.jsonl", &first);
    laptop.sync_json();
    desktop.sync_json();
    let from_laptop = release_line("personal-bbbb", "2026-11-13T02:00:00Z");
    let from_desktop = release_line("personal-cccc", "2026-11-13T03:00:00Z");
    laptop.append_machine_fact_line("shared", "2026-11.jsonl", &from_laptop);
    desktop.append_machine_fact_line("shared", "2026-11.jsonl", &from_desktop);

    laptop.sync_json();
    let merged = desktop.sync_json();
    laptop.sync_json();

    assert_eq!(merged["merged"], json!(true), "{merged}");
    for home in [&laptop, &desktop] {
        let mut tickets: Vec<Value> = home
            .fact_lines()
            .iter()
            .map(|line| line["ticket"].clone())
            .collect();
        tickets.sort_by_key(ToString::to_string);

        assert_eq!(
            tickets,
            [
                json!("personal-aaaa"),
                json!("personal-bbbb"),
                json!("personal-cccc")
            ]
        );
    }
}

#[test]
fn a_ticket_changed_on_both_machines_stops_sync_with_conflict_and_keeps_the_local_text() {
    let remote = Remote::new();
    let laptop = Home::on_remote(&remote, "laptop");
    let desktop = Home::on_remote(&remote, "desktop");
    let id = laptop.new_ticket(&["task", "Renew the domain"]);
    laptop.settle_files();
    laptop.sync_json();
    desktop.sync_json();
    let laptop_path = ticket_path(&laptop, &id);
    let desktop_path = ticket_path(&desktop, &id);
    std::fs::write(
        &laptop_path,
        "---\nkind: task\ntitle: Renew for one year\n---\n",
    )
    .expect("edit on the laptop");
    let local_text = "---\nkind: task\ntitle: Renew for two years\n---\n";
    std::fs::write(&desktop_path, local_text).expect("edit on the desktop");
    laptop.settle_files();
    desktop.settle_files();
    laptop.sync_json();

    let run = desktop.tikk(&["sync", "--json"]);

    assert_eq!(run.exit_code, 1, "{}", run.stderr);
    assert_eq!(run.stdout, "");
    let error = &parse_json(&run.stderr)["error"];
    assert_eq!(error["code"], json!("conflict"), "{error}");
    assert_eq!(error["files"], json!([relative(&desktop, &desktop_path)]));
    assert!(!desktop.store().join(".git/MERGE_HEAD").exists());
    assert_eq!(desktop.git(&["status", "--porcelain"]), "");
    assert_eq!(
        std::fs::read_to_string(&desktop_path).expect("read the ticket"),
        local_text
    );
    let saved = parse_json(
        &std::fs::read_to_string(desktop.store().join(".git/tikk-sync.json"))
            .expect("read the saved result"),
    );
    assert_eq!(saved["conflict"], error["files"]);
}

#[test]
fn a_ticket_that_does_not_parse_stays_pending_and_out_of_the_commit() {
    let remote = Remote::new();
    let laptop = Home::on_remote(&remote, "laptop");
    let kept = laptop.new_ticket(&["task", "Renew the domain"]);
    let broken = laptop.new_ticket(&["task", "Back up the mail"]);
    let broken_path = ticket_path(&laptop, &broken);
    std::fs::write(&broken_path, "---\nkind: [\n---\n").expect("break the ticket by hand");
    laptop.settle_files();

    let result = laptop.sync_json();

    assert_eq!(
        result["committedPaths"],
        json!([relative(&laptop, &ticket_path(&laptop, &kept))])
    );
    assert_eq!(
        result["pending"],
        json!([{ "path": relative(&laptop, &broken_path), "reason": "unparsed" }])
    );
    assert_eq!(
        laptop.git(&["ls-files", "--", "tickets"]).trim(),
        relative(&laptop, &ticket_path(&laptop, &kept))
    );
}

#[test]
fn new_then_sync_commits_the_new_ticket() {
    let remote = Remote::new();
    let laptop = Home::on_remote(&remote, "laptop");
    let id = laptop.new_ticket(&["task", "Renew the domain"]);

    let result = laptop.sync_json();

    assert_eq!(
        result["committedPaths"],
        json!([relative(&laptop, &ticket_path(&laptop, &id))])
    );
    assert_eq!(result["pending"], json!([]));
    assert_eq!(result["merged"], json!(false), "the remote had nothing new");
    assert_eq!(result["pushed"], json!(true));
    assert_eq!(
        remote
            .git(&["ls-tree", "-r", "--name-only", "main"])
            .lines()
            .count(),
        3
    );
}

#[test]
fn a_ticket_that_keeps_changing_through_the_wait_stays_pending_as_settling() {
    let remote = Remote::new();
    let laptop = Home::on_remote(&remote, "laptop");
    let id = laptop.new_ticket(&["task", "Renew the domain"]);
    let path = ticket_path(&laptop, &id);
    let stop = Arc::new(AtomicBool::new(false));
    let started = Arc::new(Barrier::new(2));
    let writer = {
        let (stop, started, path) = (Arc::clone(&stop), Arc::clone(&started), path.clone());

        thread::spawn(move || {
            let mut round = 0;

            started.wait();
            while !stop.load(Ordering::SeqCst) {
                round += 1;
                std::fs::write(
                    &path,
                    format!("---\nkind: task\ntitle: Renew the domain\n---\nDraft {round}\n"),
                )
                .expect("the editor saves");
                thread::sleep(std::time::Duration::from_millis(100));
            }
        })
    };
    started.wait();

    let run = laptop.tikk(&["sync", "--json"]);
    stop.store(true, Ordering::SeqCst);
    writer.join().expect("the editor stops");

    assert_eq!(run.exit_code, 0, "{}", run.stderr);
    let result = parse_json(&run.stdout);
    assert_eq!(
        result["pending"],
        json!([{ "path": relative(&laptop, &path), "reason": "settling" }])
    );
    assert_eq!(result["committed"], json!(false));
}

#[test]
fn a_rewritten_fact_line_makes_sync_refuse_and_change_nothing() {
    let remote = Remote::new();
    let laptop = Home::on_remote(&remote, "laptop");
    let line = release_line("personal-aaaa", "2026-11-13T01:00:00Z");
    laptop.append_machine_fact_line("laptop", "2026-11.jsonl", &line);
    laptop.sync_json();
    let path = laptop.store().join("facts/laptop/2026-11.jsonl");
    let rewritten = release_line("personal-bbbb", "2026-11-13T01:00:00Z");
    std::fs::write(&path, format!("{rewritten}\n")).expect("rewrite the fact by hand");
    let head = laptop.git(&["rev-parse", "HEAD"]);
    let status = laptop.git(&["status", "--porcelain"]);

    let run = laptop.tikk(&["sync", "--json"]);

    assert_eq!(run.exit_code, 1, "{}", run.stderr);
    assert_eq!(
        parse_json(&run.stderr)["error"]["code"],
        json!("factRewritten")
    );
    assert_eq!(laptop.git(&["rev-parse", "HEAD"]), head);
    assert_eq!(laptop.git(&["status", "--porcelain"]), status);
    assert_eq!(
        std::fs::read_to_string(&path).expect("read the fact file"),
        format!("{rewritten}\n")
    );
}

#[test]
fn sync_without_origin_commits_and_reports_that_it_did_not_fetch() {
    let home = Home::initialized();
    home.new_ticket(&["task", "Renew the domain"]);
    home.settle_files();

    let result = home.sync_json();

    assert_eq!(result["committed"], json!(true), "{result}");
    assert_eq!(result["fetched"], json!(false));
    assert_eq!(result["pushed"], json!(false));
    assert_eq!(result["problems"][0]["step"], json!("fetch"));
    assert_eq!(home.git(&["rev-list", "--count", "main"]).trim(), "2");
}

#[test]
fn sync_saves_its_last_result_in_the_git_folder() {
    let remote = Remote::new();
    let laptop = Home::on_remote(&remote, "laptop");

    let result = laptop.sync_json();

    let saved = parse_json(
        &std::fs::read_to_string(laptop.store().join(".git/tikk-sync.json"))
            .expect("read the saved result"),
    );
    let mut expected = result;
    expected["at"] = saved["at"].clone();
    assert_eq!(saved, expected);
    assert!(saved["at"].as_str().is_some_and(|at| at.ends_with('Z')));
}

#[test]
fn sync_without_json_prints_one_line_per_step_and_pending_file() {
    let home = Home::initialized();

    let run = home.tikk(&["sync"]);

    assert_eq!(run.exit_code, 0, "{}", run.stderr);
    assert_eq!(
        run.stdout,
        "committed: 0  fetched: no  merged: no  pushed: no\nproblem: fetch: The store has no `origin` remote, so sync only commits.\n"
    );
}

#[test]
fn sync_runs_no_hook_of_the_store() {
    let remote = Remote::new();
    let laptop = Home::on_remote(&remote, "laptop");
    let desktop = Home::on_remote(&remote, "desktop");
    let marker = desktop.work().join("hook-ran");
    for hook in [
        "pre-commit",
        "commit-msg",
        "post-commit",
        "pre-merge-commit",
        "post-merge",
        "pre-push",
        "post-checkout",
        "reference-transaction",
    ] {
        let path = desktop.store().join(".git/hooks").join(hook);
        std::fs::write(
            &path,
            format!("#!/bin/sh\necho {hook} >> '{}'\n", marker.display()),
        )
        .expect("write a hook");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("make the hook executable");
    }
    laptop.new_ticket(&["task", "Renew the domain"]);
    desktop.new_ticket(&["task", "Back up the mail"]);
    laptop.settle_files();
    desktop.settle_files();
    laptop.sync_json();

    let result = desktop.sync_json();

    assert_eq!(result["committed"], json!(true), "{result}");
    assert_eq!(result["merged"], json!(true), "{result}");
    assert_eq!(result["pushed"], json!(true), "{result}");
    assert_eq!(
        desktop
            .git(&["rev-list", "--count", "--merges", "main"])
            .trim(),
        "1"
    );
    assert!(
        !marker.exists(),
        "hooks ran: {}",
        std::fs::read_to_string(&marker).unwrap_or_default()
    );
}

#[test]
fn ls_during_a_sync_with_a_merge_lists_the_old_or_the_new_tickets() {
    let remote = Remote::new();
    let laptop = Home::on_remote(&remote, "laptop");
    let desktop = Home::on_remote(&remote, "desktop");
    let old = vec![desktop.new_ticket(&["task", "Back up the mail"])];
    for title in ["Renew the domain", "Pay the bill", "Fix the printer"] {
        laptop.new_ticket(&["task", title]);
    }
    laptop.settle_files();
    desktop.settle_files();
    laptop.sync_json();
    let mut new = old.clone();
    new.extend(laptop.listed_ids());
    new.sort();
    let started = Arc::new(Barrier::new(2));
    let done = Arc::new(AtomicBool::new(false));
    let reader = {
        let (started, done) = (Arc::clone(&started), Arc::clone(&done));
        let commands: Vec<_> = (0..1000)
            .map(|_| desktop.command(&["ls", "--json"]))
            .collect();

        thread::spawn(move || {
            let mut listings = Vec::new();

            started.wait();
            for mut command in commands {
                let finished = done.load(Ordering::SeqCst);

                listings.push(finish(command.output().expect("start tikk ls")));

                if finished {
                    break;
                }
            }

            listings
        })
    };
    let mut sync = desktop.command(&["sync", "--json"]);
    sync.stdout(Stdio::piped()).stderr(Stdio::piped());
    started.wait();
    let child = sync.spawn().expect("start tikk sync");
    let synced = finish(child.wait_with_output().expect("wait for tikk sync"));
    done.store(true, Ordering::SeqCst);
    let listings = reader.join().expect("the reader ends");

    assert_eq!(synced.exit_code, 0, "{}", synced.stderr);
    assert_eq!(parse_json(&synced.stdout)["merged"], json!(true));
    assert!(listings.len() > 1, "only {} listings", listings.len());
    for listing in &listings {
        assert_eq!(listing.exit_code, 0, "{}", listing.stderr);
        let mut ids: Vec<String> = parse_json(&listing.stdout)["tickets"]
            .as_array()
            .expect("ls lists tickets")
            .iter()
            .map(|ticket| ticket["id"].as_str().expect("a row has an ID").to_owned())
            .collect();
        ids.sort();

        assert!(ids == old || ids == new, "ls listed {ids:?}");
    }
    assert_eq!(
        listings
            .last()
            .map(|run| run.stdout.matches("\"id\"").count()),
        Some(4)
    );
}
