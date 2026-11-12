//! Journey tickets-by-hand: the user at a shell, with no agent, sets up a store and keeps a plan's
//! to-dos in order. Steps match `.pi/qa/journeys/tickets-by-hand.md`.

mod support;

use support::Home;

#[test]
fn tickets_by_hand() {
    let home = Home::new();

    // Step 1: `tikk init` creates the store, and a second `tikk init` reports that it exists.
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
