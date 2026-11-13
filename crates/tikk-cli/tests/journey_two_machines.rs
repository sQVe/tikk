mod support;

use serde_json::json;

use support::{Home, Remote, parse_json};

#[test]
fn two_machines() {
    let remote = Remote::new();
    let laptop = Home::new();
    let desktop = Home::new();

    for (home, machine) in [(&laptop, "laptop"), (&desktop, "desktop")] {
        let run = home.tikk(&[
            "init",
            "--remote",
            &remote.url(),
            "--machine",
            machine,
            "--json",
        ]);

        assert_eq!(
            run.exit_code, 0,
            "step 1, init on the {machine}: {}",
            run.stderr
        );
        assert_eq!(
            parse_json(&run.stdout)["created"],
            json!(true),
            "step 1, init on the {machine}"
        );
    }

    let (plan, slice) = laptop.plan_and_slice();
    let laptop_sync = laptop.tikk(&["sync", "--json"]);

    assert_eq!(
        laptop_sync.exit_code, 0,
        "step 2, laptop sync: {}",
        laptop_sync.stderr
    );
    let result = parse_json(&laptop_sync.stdout);
    assert_eq!(
        result["committed"],
        json!(true),
        "step 2, laptop sync: {result}"
    );
    assert_eq!(
        result["pushed"],
        json!(true),
        "step 2, laptop sync: {result}"
    );
    let desktop_sync = desktop.tikk(&["sync"]);
    assert_eq!(
        desktop_sync.exit_code, 0,
        "step 2, desktop sync: {}",
        desktop_sync.stderr
    );
    let mut expected = vec![plan, slice.clone()];
    expected.sort();
    assert_eq!(
        desktop.listed_ids(),
        expected,
        "step 2, desktop ls lists both tickets"
    );

    let laptop_claim = laptop.tikk_as("manager-laptop", &["claim", &slice, "--json"]);

    assert_eq!(
        laptop_claim.exit_code, 0,
        "step 3, laptop claim: {}",
        laptop_claim.stderr
    );
    let desktop_claim = desktop.tikk_as("manager-desktop", &["claim", &slice, "--json"]);
    assert_eq!(
        desktop_claim.exit_code, 1,
        "step 3, desktop claim: {}",
        desktop_claim.stdout
    );
    assert_eq!(
        parse_json(&desktop_claim.stderr)["error"]["code"],
        json!("claimed"),
        "step 3, desktop claim"
    );

    let release = laptop.tikk_as("manager-laptop", &["release", &slice, "--json"]);

    assert_eq!(release.exit_code, 0, "step 4, release: {}", release.stderr);
    assert_eq!(
        parse_json(&release.stdout)["sync"]["pushed"],
        json!(true),
        "step 4, the release is pushed"
    );
    let desktop_claim = desktop.tikk_as("manager-desktop", &["claim", &slice, "--json"]);
    assert_eq!(
        desktop_claim.exit_code, 0,
        "step 4, desktop claim: {}",
        desktop_claim.stderr
    );

    laptop.sync_json();
    for (home, machine) in [(&laptop, "laptop"), (&desktop, "desktop")] {
        assert_eq!(
            home.show_json(&slice)["claim"]["agent"],
            json!("manager-desktop"),
            "end state, the {machine} names the desktop's agent"
        );
    }
    assert_eq!(
        desktop.listed_ids(),
        laptop.listed_ids(),
        "end state, both machines list the same tickets"
    );
}
