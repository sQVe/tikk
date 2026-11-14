mod support;

use support::Home;

#[test]
fn tickets_by_hand() {
    let home = Home::new();

    let first = home.tikk(&["init"]);
    assert_eq!(first.exit_code, 0, "step 1, first init: {}", first.stderr);
    assert!(
        first.stdout.contains("Created the tikk store"),
        "step 1, first init: {}",
        first.stdout
    );

    let second = home.tikk(&["init"]);
    assert_eq!(
        second.exit_code, 0,
        "step 1, second init: {}",
        second.stderr
    );
    assert!(
        second.stdout.contains("already exists"),
        "step 1, second init: {}",
        second.stdout
    );
}
