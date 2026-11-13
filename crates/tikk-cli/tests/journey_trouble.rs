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

    let (plan, slice) = home.plan_and_slice();
    let claim = home.tikk_as("manager", &["claim", &slice, "--json"]);
    assert_eq!(claim.exit_code, 0, "step 4, claim: {}", claim.stderr);
    let claim_line = home.fact_lines().pop().expect("the claim is the last fact");
    let mut lease_ended = claim_line.clone();
    lease_ended["leaseEnd"] = json!("2020-01-01T04:00:00Z");
    let month = claim_line["at"].as_str().expect("a fact has a time")[..7].to_owned();
    home.append_fact_line(&format!("{month}.jsonl"), &lease_ended.to_string());
    assert_eq!(
        home.show_json(&slice)["claim"]["state"],
        json!("staleClaim"),
        "step 4, the lease ended"
    );

    let release = home.tikk(&["release", &slice, "--json"]);

    assert_eq!(release.exit_code, 0, "step 4, release: {}", release.stderr);
    let ready = home.tikk(&["ready", "--parent", &plan, "--json"]);
    assert_eq!(ready.exit_code, 0, "step 4, ready: {}", ready.stderr);
    assert_eq!(
        parse_json(&ready.stdout)["candidates"][0]["id"],
        json!(slice),
        "step 4, ready offers the slice again"
    );
    assert_eq!(
        home.show_json(&slice)["claim"],
        json!(null),
        "step 4, the slice has no claim"
    );

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
    let mut listed: Vec<&str> = listing["tickets"]
        .as_array()
        .expect("ls lists tickets")
        .iter()
        .map(|ticket| ticket["id"].as_str().expect("a row has an ID"))
        .collect();
    let mut expected = vec![kept.as_str(), plan.as_str(), slice.as_str()];
    listed.sort_unstable();
    expected.sort_unstable();
    assert_eq!(listed, expected, "end state, ls lists every other ticket");
}
