mod support;

use std::process::Command;

use serde_json::json;

use support::{Home, finish, parse_json};

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
fn a_program_path_that_is_not_unicode_prints_no_script_and_exits_with_1() {
    use std::os::unix::ffi::OsStrExt as _;

    let home = Home::new();
    let folder = home.work().join(std::ffi::OsStr::from_bytes(b"tikk-\xff"));
    if !support::create_folder_unless_name_refused(&folder) {
        return;
    }
    let program = folder.join("tikk");
    std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_tikk"), &program).expect("link the binary");

    let run = finish(
        home.command_of(&program, &["completions", "bash", "--json"])
            .output()
            .expect("start the linked tikk"),
    );

    assert_eq!(run.exit_code, 1, "stdout: {}", run.stdout);
    assert_eq!(run.stdout, "");
    assert_eq!(
        parse_json(&run.stderr)["error"]["code"],
        json!("programPathNotUnicode")
    );
}
