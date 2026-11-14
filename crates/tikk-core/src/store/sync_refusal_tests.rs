use std::fs;
use std::path::PathBuf;

use super::{
    FACT, FACT_LINE, FAIL_READ, INJECTED, NETWORK, READS, TICKET, TICKET_TEXT,
    dangling_ticket_link, effects, git_text, machines_with_work, snapshot, sync, write,
};
use crate::store::StoreError;

#[test]
fn each_read_that_fails_stops_sync_before_it_changes_anything() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    write(
        &desktop,
        "tickets/personal/personal-wxyz-new.md",
        TICKET_TEXT,
    );
    write(
        &desktop,
        "tickets/personal/personal-abcd/design.md",
        "notes\n",
    );
    write(&desktop, FACT, &format!("{FACT_LINE}{FACT_LINE}"));
    fs::remove_file(desktop.join(TICKET)).expect("delete a ticket by hand");
    let before = snapshot(&desktop);
    let mut failed = 0;

    loop {
        READS.set(0);
        INJECTED.set(false);
        FAIL_READ.set(Some(failed));

        let result = sync(&desktop, &effects());

        if !INJECTED.get() {
            let outcome = result.expect("sync succeeds when no read fails");
            assert!(outcome.committed && outcome.merged, "{outcome:?}");
            break;
        }

        assert!(
            matches!(&result, Err(StoreError::Git { arguments, .. }) if arguments == "injected"),
            "read {failed}: {result:?}"
        );
        assert_eq!(snapshot(&desktop), before, "read {failed}");
        failed += 1;
    }

    assert!(failed >= 12, "only {failed} reads were failed");
}

#[test]
fn sync_refuses_a_store_in_a_merge_or_with_staged_changes_and_changes_nothing() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    write(
        &desktop,
        "tickets/personal/personal-wxyz-new.md",
        TICKET_TEXT,
    );
    write(&desktop, "notes.txt", "mine\n");
    git_text(&desktop, &["add", "notes.txt"]);
    let staged = snapshot(&desktop);

    let refused = sync(&desktop, &effects()).expect_err("a staged file is refused");

    assert!(
        matches!(&refused, StoreError::StagedChanges { paths, .. } if *paths == [PathBuf::from("notes.txt")]),
        "{refused:?}"
    );
    assert_eq!(snapshot(&desktop), staged);
    git_text(&desktop, &["rm", "--cached", "--quiet", "notes.txt"]);
    fs::write(desktop.join(".git/MERGE_HEAD"), "0000\n").expect("leave a merge in progress");
    let merging = snapshot(&desktop);

    let refused = sync(&desktop, &effects()).expect_err("a merge in progress is refused");

    assert!(
        matches!(refused, StoreError::MergeInProgress { .. }),
        "{refused:?}"
    );
    assert_eq!(snapshot(&desktop), merging);
}

#[test]
fn a_deleted_fact_file_makes_sync_refuse_and_change_nothing() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    fs::remove_file(desktop.join(FACT)).expect("delete the fact file");
    let before = snapshot(&desktop);

    let error = sync(&desktop, &effects()).expect_err("a deleted fact file is refused");

    assert!(
        matches!(&error, StoreError::FactRewritten { path } if path.ends_with(FACT)),
        "{error:?}"
    );
    assert_eq!(snapshot(&desktop), before);
}

#[test]
fn a_fact_line_changed_in_place_makes_sync_refuse_and_change_nothing() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    write(
        &desktop,
        FACT,
        &FACT_LINE.replace("personal-abcd", "personal-zzzz"),
    );
    let before = snapshot(&desktop);

    let error = sync(&desktop, &effects()).expect_err("a rewritten line is refused");

    assert!(
        matches!(&error, StoreError::FactRewritten { path } if path.ends_with(FACT)),
        "{error:?}"
    );
    assert_eq!(snapshot(&desktop), before);
}

#[test]
fn a_store_on_another_branch_is_refused_and_nothing_changes() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    git_text(&desktop, &["switch", "--quiet", "--create", "work"]);
    write(
        &desktop,
        "tickets/personal/personal-wxyz-new.md",
        TICKET_TEXT,
    );
    let before = snapshot(&desktop);

    let error = sync(&desktop, &effects()).expect_err("a store off main is refused");

    assert!(
        matches!(&error, StoreError::NotOnMain { branch, .. } if branch == "refs/heads/work"),
        "{error:?}"
    );
    assert_eq!(snapshot(&desktop), before);
}

#[test]
fn a_ticket_scan_that_fails_before_the_commit_refuses_and_changes_nothing() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    write(
        &desktop,
        "tickets/personal/personal-wxyz-new.md",
        TICKET_TEXT,
    );
    dangling_ticket_link(&desktop);
    let before = snapshot(&desktop);
    NETWORK.set(Vec::new());

    let error = sync(&desktop, &effects()).expect_err("the scan fails");

    assert!(
        matches!(&error, StoreError::Io { path, .. } if path.ends_with("personal-zzzz-link.md")),
        "{error:?}"
    );
    assert_eq!(snapshot(&desktop), before);
    assert_eq!(NETWORK.take(), ["fetch --quiet --no-tags --prune origin"]);
}
