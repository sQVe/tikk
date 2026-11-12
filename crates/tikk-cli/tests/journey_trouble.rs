mod support;

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
    std::fs::write(
        &path,
        "---\nkind: task\ntitle: Lock the store\nstatus: [open\n---\n",
    )
    .expect("break the ticket file by hand");

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
}
