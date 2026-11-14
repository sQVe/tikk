mod support;

use std::time::{Duration, Instant};

use serde_json::json;

use support::{FakeGh, Home, Remote, parse_json};

#[test]
fn trouble() {
    let remote = Remote::new();
    let home = Home::on_remote(&remote, "test");
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

    let desktop = Home::on_remote(&remote, "desktop");
    home.settle_files();
    assert_eq!(
        home.sync_json()["pushed"],
        json!(true),
        "step 5, first sync"
    );
    desktop.sync_json();
    let plan_path = home.show_json(&plan)["path"]
        .as_str()
        .expect("show prints the path")
        .to_owned();
    let desktop_plan_path = desktop.show_json(&plan)["path"]
        .as_str()
        .expect("show prints the path")
        .to_owned();
    std::fs::write(
        &desktop_plan_path,
        "---\nkind: plan\ntitle: Move to tikk this year\n---\n",
    )
    .expect("edit the plan on the desktop");
    let local_plan = "---\nkind: plan\ntitle: Move to tikk next week\n---\n";
    std::fs::write(&plan_path, local_plan).expect("edit the plan here");
    desktop.settle_files();
    home.settle_files();
    assert_eq!(
        desktop.sync_json()["pushed"],
        json!(true),
        "step 5, desktop sync"
    );

    let conflict = home.tikk(&["sync", "--json"]);

    assert_eq!(
        conflict.exit_code, 1,
        "step 5, second sync: {}",
        conflict.stderr
    );
    assert_eq!(conflict.stdout, "", "step 5, second sync");
    let error = &parse_json(&conflict.stderr)["error"];
    assert_eq!(error["code"], json!("conflict"), "step 5, second sync");
    let relative_plan = std::path::Path::new(&plan_path)
        .strip_prefix(home.store())
        .expect("inside the store")
        .to_str()
        .expect("a UTF-8 path")
        .to_owned();
    assert_eq!(
        error["files"],
        json!([relative_plan]),
        "step 5, the error names the file"
    );
    assert_eq!(
        std::fs::read_to_string(&plan_path).expect("read the plan"),
        local_plan,
        "step 5, the plan keeps the local text"
    );
    assert!(
        !home.store().join(".git/MERGE_HEAD").exists(),
        "step 5, no merge stays in progress"
    );

    let clash_remote = Remote::new();
    let laptop = Home::on_remote(&clash_remote, "laptop");
    let desktop = Home::on_remote(&clash_remote, "desktop");
    let (_clash_plan, drawn) = laptop.plan_and_slice();
    laptop.settle_files();
    laptop.sync_json();
    desktop.sync_json();
    let laptop_file = std::path::PathBuf::from(
        laptop.show_json(&drawn)["path"]
            .as_str()
            .expect("show prints the path"),
    );
    let desktop_file = desktop
        .store()
        .join(
            laptop_file
                .strip_prefix(laptop.store())
                .expect("inside the store"),
        )
        .with_file_name(format!("{drawn}-other-work.md"));
    let other_work = std::fs::read_to_string(&laptop_file)
        .expect("read the slice")
        .replace("title: Add the store", "title: Other work");
    std::fs::write(&desktop_file, other_work).expect("the desktop draws the same ID");
    desktop.settle_files();
    desktop.sync_json();

    let clash_sync = laptop.sync_json();

    let other_file = laptop.store().join(
        desktop_file
            .strip_prefix(desktop.store())
            .expect("inside the store"),
    );
    let relative = |file: &std::path::Path| {
        file.strip_prefix(laptop.store())
            .expect("inside the store")
            .to_str()
            .expect("a UTF-8 path")
            .to_owned()
    };
    let mut clash_paths = vec![relative(&laptop_file), relative(&other_file)];
    clash_paths.sort();
    assert_eq!(
        clash_sync["clashes"],
        json!([{ "id": drawn, "paths": clash_paths }]),
        "step 6, sync names both files: {clash_sync}"
    );
    let shared_claim = laptop.tikk_as("manager", &["claim", &drawn, "--json"]);
    assert_eq!(
        shared_claim.exit_code, 1,
        "step 6, claim of the shared ID: {}",
        shared_claim.stdout
    );
    assert_eq!(
        parse_json(&shared_claim.stderr)["error"]["code"],
        json!("idShared"),
        "step 6, claim of the shared ID"
    );
    let (project, suffix) = drawn.rsplit_once('-').expect("an ID has a project");
    let new_suffix = if suffix == "zzzz" { "yyyy" } else { "zzzz" };
    let new_id = format!("{project}-{new_suffix}");
    std::fs::rename(
        &other_file,
        other_file.with_file_name(format!("{new_id}-other-work.md")),
    )
    .expect("the user renames one file");
    laptop.settle_files();
    let renamed_claim = laptop.tikk_as("manager", &["claim", &drawn, "--json"]);
    assert_eq!(
        renamed_claim.exit_code, 0,
        "step 6, claim after the rename: {}",
        renamed_claim.stderr
    );

    let gh = FakeGh::new();
    let url = "https://github.com/owner/app/pull/12";
    gh.open_pr("owner/app", 12, "1111111111111111111111111111111111111111");
    let link = home.tikk_with_gh(&gh, None, &["pr", "link", &slice, url, "--json"]);
    assert_eq!(link.exit_code, 0, "step 7, pr link: {}", link.stderr);
    gh.fail_pr("owner/app", 12, "HTTP 502: Bad Gateway");

    let refresh = home.tikk_with_gh(&gh, None, &["pr", "refresh", "--json"]);

    assert_eq!(
        refresh.exit_code, 1,
        "step 7, pr refresh: {}",
        refresh.stdout
    );
    let gh_error = parse_json(&refresh.stderr)["error"].clone();
    assert_eq!(gh_error["code"], json!("ghError"), "step 7, pr refresh");
    assert_eq!(
        gh_error["pullRequests"][0]["url"],
        json!(url),
        "step 7, the error names the PR: {gh_error}"
    );
    assert!(
        gh_error["message"]
            .as_str()
            .is_some_and(|message| message.contains(url)),
        "step 7, the message names the PR: {gh_error}"
    );
    let ready_after = home.tikk_with_gh(&gh, None, &["ready", "--parent", &plan, "--json"]);
    assert_eq!(
        ready_after.exit_code, 0,
        "step 7, ready: {}",
        ready_after.stderr
    );

    assert_eq!(
        home.show_json(&slice)["pr"]["state"],
        json!("open"),
        "end state, the slice keeps its last recorded PR state"
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
    assert_eq!(
        laptop.show_json(&drawn)["claim"]["agent"],
        json!("manager"),
        "end state, the slice that kept the ID is claimed"
    );
    assert_eq!(
        laptop.sync_json()["clashes"],
        json!([]),
        "end state, sync lists no clash"
    );
}
