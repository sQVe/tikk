mod support;

use std::fs::TryLockError;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;

use support::{Home, finish, parse_json};

#[test]
fn eight_processes_that_finish_or_cancel_tickets_keep_every_change() {
    let home = Home::initialized();
    let tasks: Vec<String> = (0..8)
        .map(|number| home.new_ticket(&["task", &format!("Task {number}")]))
        .collect();
    let children: Vec<_> = tasks
        .iter()
        .enumerate()
        .map(|(number, id)| {
            let reason = format!("Reason {number}");
            let arguments = if number % 2 == 0 {
                vec!["done", id.as_str()]
            } else {
                vec!["cancel", id.as_str(), "--reason", reason.as_str()]
            };

            home.command(&arguments)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("start the tikk binary")
        })
        .collect();

    for child in children {
        let run = finish(child.wait_with_output().expect("wait for tikk"));

        assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    }

    for (number, id) in tasks.iter().enumerate() {
        let shown = home.show_json(id);
        let (status, reason) = if number % 2 == 0 {
            (json!("done"), json!(null))
        } else {
            (json!("canceled"), json!(format!("Reason {number}")))
        };

        assert_eq!(shown["status"], status, "case {number}");
        assert_eq!(shown["reason"], reason, "case {number}");
    }
}

#[test]
fn show_waits_for_a_lock_released_within_five_seconds() {
    let home = Home::initialized();
    let id = home.new_ticket(&["task", "Renew the domain"]);
    let holder = home.lock_file();
    holder.lock().expect("take the exclusive lock");
    let started = Instant::now();
    let show = home
        .command(&["show", &id, "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start the tikk binary");

    thread::sleep(Duration::from_secs(1));
    holder.unlock().expect("release the lock");
    let run = finish(show.wait_with_output().expect("wait for tikk"));

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(parse_json(&run.stdout)["id"], json!(id));
    assert!(
        started.elapsed() >= Duration::from_secs(1),
        "show did not wait"
    );
}

#[test]
fn show_under_a_lock_held_past_five_seconds_exits_with_1_and_locked() {
    let home = Home::initialized();
    let id = home.new_ticket(&["task", "Renew the domain"]);
    let holder = home.lock_file();
    holder.lock().expect("take the exclusive lock");

    let run = home.tikk(&["show", &id, "--json"]);

    assert_eq!(run.exit_code, 1, "stdout: {}", run.stdout);
    assert_eq!(parse_json(&run.stderr)["error"]["code"], json!("locked"));
    holder.unlock().expect("release the lock");
}

#[test]
fn a_killed_lock_holder_leaves_the_lock_free_for_the_next_write() {
    let home = Home::initialized();
    let id = home.new_ticket(&["task", "Renew the domain"]);
    let locked = home.lock_file();
    locked.lock().expect("take the exclusive lock");
    let mut holder = Command::new("sleep")
        .arg("60")
        .stdin(Stdio::from(locked))
        .spawn()
        .expect("start a process that holds the lock");
    let probe = home.lock_file();
    assert!(
        matches!(probe.try_lock(), Err(TryLockError::WouldBlock)),
        "the child holds the lock"
    );

    holder.kill().expect("kill the lock holder");
    holder.wait().expect("wait for the killed holder");
    let run = home.tikk(&["done", &id, "--json"]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(home.show_json(&id)["status"], json!("done"));
}
