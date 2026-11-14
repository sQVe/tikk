use super::{FAIL_GIT, NETWORK, TICKET_TEXT, effects, git_text, machines_with_work, sync, write};
use crate::store::sync::SyncStep;

#[test]
fn a_fetch_that_times_out_still_commits_and_skips_the_merge_and_the_push() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    write(
        &desktop,
        "tickets/personal/personal-wxyz-new.md",
        TICKET_TEXT,
    );
    let head = git_text(&desktop, &["rev-parse", "HEAD"]);
    NETWORK.set(Vec::new());
    FAIL_GIT.set(vec!["fetch"]);

    let outcome = sync(&desktop, &effects()).expect("a network failure is a result");

    assert!(outcome.committed, "{outcome:?}");
    assert!(
        !outcome.fetched && !outcome.merged && !outcome.pushed,
        "{outcome:?}"
    );
    assert_eq!(outcome.problems.len(), 1);
    assert_eq!(outcome.problems[0].step, SyncStep::Fetch);
    assert!(
        outcome.problems[0].message.contains("did not finish"),
        "{outcome:?}"
    );
    assert_eq!(NETWORK.take(), ["fetch --quiet --no-tags --prune origin"]);
    assert_eq!(
        git_text(&desktop, &["rev-parse", "HEAD~1"]),
        head,
        "the commit sits on the old HEAD, with no merge"
    );
}

#[test]
fn a_failed_push_is_a_problem_and_the_next_sync_pushes() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    write(
        &desktop,
        "tickets/personal/personal-wxyz-new.md",
        TICKET_TEXT,
    );
    FAIL_GIT.set(vec!["push"]);

    let failed = sync(&desktop, &effects()).expect("a network failure is a result");
    FAIL_GIT.set(Vec::new());
    let next = sync(&desktop, &effects()).expect("the next sync runs");

    assert!(
        failed.committed && failed.merged && !failed.pushed,
        "{failed:?}"
    );
    assert_eq!(failed.problems[0].step, SyncStep::Push);
    assert!(!next.committed && !next.merged && next.pushed, "{next:?}");
    assert_eq!(
        git_text(&machines.laptop(), &["ls-remote", "origin", "main"])
            .split('\t')
            .next(),
        Some(git_text(&desktop, &["rev-parse", "HEAD"]).trim())
    );
}
