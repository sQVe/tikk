mod support;

use std::os::unix::fs::PermissionsExt as _;

use serde_json::json;

use support::{Home, Remote, finish, parse_json};

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
fn network_steps_use_the_global_git_config_but_run_no_global_hook() {
    let remote = Remote::new();
    let setup = tempfile::tempdir().expect("create a temporary directory");
    let hooks = setup.path().join("hooks");
    let marker = setup.path().join("hook-ran");
    std::fs::create_dir(&hooks).expect("create the hooks folder");
    for hook in [
        "pre-push",
        "reference-transaction",
        "post-checkout",
        "post-commit",
        "post-merge",
    ] {
        let path = hooks.join(hook);
        std::fs::write(
            &path,
            format!(
                "#!/bin/sh\necho \"{hook} $(pwd)\" >> '{}'\n",
                marker.display()
            ),
        )
        .expect("write a hook");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("make the hook executable");
    }
    let global_config = setup.path().join("gitconfig");
    std::fs::write(
        &global_config,
        format!(
            "[core]\n\thooksPath = {}\n[url \"{}\"]\n\tinsteadOf = tikk-test://remote\n",
            hooks.display(),
            remote.url()
        ),
    )
    .expect("write the global Git config");
    let run = |home: &Home, arguments: &[&str]| {
        let mut command = home.command(arguments);

        command.env("GIT_CONFIG_GLOBAL", &global_config);

        finish(command.output().expect("start the tikk binary"))
    };
    let laptop = Home::new();
    let desktop = Home::new();

    let inits: Vec<_> = [(&laptop, "laptop"), (&desktop, "desktop")]
        .into_iter()
        .map(|(home, machine)| {
            run(
                home,
                &[
                    "init",
                    "--remote",
                    "tikk-test://remote",
                    "--machine",
                    machine,
                    "--json",
                ],
            )
        })
        .collect();
    laptop.new_ticket(&["task", "Renew the domain"]);
    desktop.new_ticket(&["task", "Back up the mail"]);
    laptop.settle_files();
    desktop.settle_files();
    let first = run(&laptop, &["sync", "--json"]);
    let second = run(&desktop, &["sync", "--json"]);

    for init in &inits {
        assert_eq!(init.exit_code, 0, "{}", init.stderr);
    }
    assert_eq!(first.exit_code, 0, "{}", first.stderr);
    assert_eq!(second.exit_code, 0, "{}", second.stderr);
    let result = parse_json(&second.stdout);
    assert_eq!(result["merged"], json!(true), "{result}");
    assert_eq!(result["pushed"], json!(true), "{result}");
    assert_eq!(result["problems"], json!([]), "{result}");
    // A local-path remote runs its own receive-pack hooks, as a server does. Only hooks in a store
    // count.
    let ran = std::fs::read_to_string(&marker).unwrap_or_default();
    let in_a_store: Vec<&str> = ran
        .lines()
        .filter(|line| !line.ends_with(remote.path().to_str().expect("a UTF-8 path")))
        .collect();
    assert_eq!(in_a_store, Vec::<&str>::new(), "all hooks that ran: {ran}");
}
