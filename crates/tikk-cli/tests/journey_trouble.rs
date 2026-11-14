mod support;

use std::time::{Duration, Instant};

use serde_json::json;

use support::{Home, parse_json};

#[test]
fn trouble() {
    let home = Home::initialized();
    let kept = home.new_ticket(&["task", "Renew the domain"]);
    let broken = home.new_ticket(&["task", "Lock the store"]);
    let path = home
        .store()
        .join(format!("tickets/personal/{broken}-lock-the-store.md"));
    let broken_text = "---\nkind: task\ntitle: Lock the store\nstatus: [open\n---\n";
    std::fs::write(&path, broken_text).expect("break the ticket file by hand");

    let listing = home.tikk(&["ls", "--json"]);

    assert_eq!(listing.exit_code, 0, "step 1, ls: {}", listing.stderr);
    let listed = parse_json(&listing.stdout);
    assert_eq!(
        listed["tickets"][0]["id"],
        json!(kept),
        "step 1, ls keeps the rest"
    );
    assert_eq!(
        listed["errors"][0]["path"],
        json!(path.to_str().expect("a UTF-8 path")),
        "step 1, ls names the broken file"
    );

    let show = home.tikk(&["show", &broken, "--json"]);

    assert_eq!(show.exit_code, 1, "step 1, show");
    assert_eq!(
        parse_json(&show.stderr)["error"]["code"],
        json!("parseError"),
        "step 1, show"
    );

    let agent_view = home.show_json(&kept);
    let kept_path = agent_view["path"].as_str().expect("show prints the path");
    let user_edit = "---\nkind: task\ntitle: Renew the domain\n---\nPaid until May.\n";
    std::fs::write(kept_path, user_edit).expect("the user edits the ticket");
    let agent_document = home.document(
        "agent.md",
        "---\nkind: task\ntitle: Renew the domain for two years\n---\n",
    );

    let stale_write = home.tikk(&[
        "write",
        &kept,
        "--file",
        agent_document.to_str().expect("a UTF-8 path"),
        "--hash",
        agent_view["hash"].as_str().expect("show prints the hash"),
        "--json",
    ]);

    assert_eq!(stale_write.exit_code, 1, "step 2, write with an old hash");
    assert_eq!(
        parse_json(&stale_write.stderr)["error"]["code"],
        json!("changedOnDisk"),
        "step 2, write with an old hash"
    );
    assert_eq!(
        std::fs::read_to_string(kept_path).expect("read the edited file"),
        user_edit,
        "step 2, the user's edit stays"
    );

    let holder = home.lock_file();
    holder.lock().expect("another process takes the store lock");
    let started = Instant::now();

    let locked_show = home.tikk(&["show", &kept, "--json"]);

    assert_eq!(locked_show.exit_code, 1, "step 3, show under a held lock");
    assert_eq!(
        parse_json(&locked_show.stderr)["error"]["code"],
        json!("locked"),
        "step 3, show under a held lock"
    );
    assert!(
        started.elapsed() >= Duration::from_secs(5),
        "step 3, show waits five seconds first"
    );
    holder
        .unlock()
        .expect("the other process releases the lock");

    assert_eq!(
        std::fs::read_to_string(&path).expect("read the broken file"),
        broken_text,
        "end state, the broken file stays as the user left it"
    );
    assert_eq!(
        std::fs::read_to_string(kept_path).expect("read the edited file"),
        user_edit,
        "end state, the user's edit stays"
    );
    let listing = parse_json(&home.tikk(&["ls", "--json"]).stdout);
    assert_eq!(
        listing["tickets"][0]["id"],
        json!(kept),
        "end state, ls lists every other ticket"
    );
}
