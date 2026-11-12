mod support;

use serde_json::json;

use support::{Home, parse_json};

#[test]
fn unknown_flag_with_json_exits_with_2_and_an_error_object() {
    let home = Home::new();

    let run = home.tikk(&["init", "--json", "--no-such-flag"]);

    assert_eq!(run.exit_code, 2);
    assert_eq!(run.stdout, "");
    let error = parse_json(&run.stderr);
    assert_eq!(error["error"]["code"], json!("invalidArguments"));
    assert!(
        error["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("--no-such-flag")),
        "{error}"
    );
}

#[test]
fn unknown_flag_without_json_exits_with_2_and_prints_usage() {
    let home = Home::new();

    let run = home.tikk(&["--no-such-flag"]);

    assert_eq!(run.exit_code, 2);
    assert_eq!(run.stdout, "");
    assert!(run.stderr.contains("Usage:"), "{}", run.stderr);
}

#[test]
fn no_command_is_wrong_usage() {
    let home = Home::new();

    let run = home.tikk(&["--json"]);

    assert_eq!(run.exit_code, 2);
    assert_eq!(
        parse_json(&run.stderr)["error"]["code"],
        json!("invalidArguments")
    );
}

#[test]
fn version_json_prints_the_version() {
    let home = Home::new();

    let run = home.tikk(&["--version", "--json"]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert_eq!(run.stdout, "{\"version\":\"0.0.0\"}\n");
}

#[test]
fn help_exits_with_0_and_prints_the_usage() {
    let home = Home::new();

    let run = home.tikk(&["--help"]);

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    assert!(
        run.stdout.contains("A local ticket tracker for AI agents"),
        "{}",
        run.stdout
    );
    assert!(run.stdout.contains("Usage:"), "{}", run.stdout);
}
