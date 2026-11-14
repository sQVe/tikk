use std::fs;
use std::path::{Path, PathBuf};

use super::{
    FAIL_GIT, LOCAL_EDIT, NETWORK, TICKET, TICKET_TEXT, dangling_ticket_link, effects, fake_entry,
    git_text, machines_in_conflict, machines_with_work, sync, write,
};
use crate::store::sync::{SyncEffects, SyncStep};
use crate::store::{FileEntry, IdClash, StoreError};
use crate::ticket::TicketId;

// The preflight also reads `MERGE_HEAD`. Only the read after a failed merge finds the file.
fn entry_failing_on_merge_head(path: &Path) -> Result<Option<FileEntry>, StoreError> {
    if path.ends_with(".git/MERGE_HEAD") && path.exists() {
        return Err(StoreError::Git {
            arguments: "read MERGE_HEAD".to_owned(),
            message: "injected".to_owned(),
        });
    }

    fake_entry(path)
}

#[test]
fn a_failed_read_of_the_conflicts_still_aborts_the_merge_and_reports_both_errors() {
    let machines = machines_in_conflict();
    let desktop = machines.desktop();
    NETWORK.set(Vec::new());
    FAIL_GIT.set(vec!["diff --name-only"]);

    let error = sync(&desktop, &effects()).expect_err("the conflict list cannot be read");

    assert!(
        matches!(&error, StoreError::ConflictsUnreadable { merge, read }
            if matches!(**merge, StoreError::Git { ref arguments, .. } if arguments.starts_with("merge"))
                && matches!(**read, StoreError::Git { ref arguments, .. } if arguments.starts_with("diff"))),
        "{error:?}"
    );
    assert!(!desktop.join(".git/MERGE_HEAD").exists());
    assert_eq!(
        fs::read_to_string(desktop.join(TICKET)).expect("read the ticket"),
        LOCAL_EDIT
    );
    assert!(NETWORK.with_borrow(|calls| !calls.iter().any(|call| call.starts_with("push"))));
}

#[test]
fn a_failed_read_of_merge_head_still_aborts_the_merge_and_reports_both_errors() {
    let machines = machines_in_conflict();
    let desktop = machines.desktop();
    NETWORK.set(Vec::new());
    let failing = SyncEffects {
        read_entry: entry_failing_on_merge_head,
        ..effects()
    };

    let error = sync(&desktop, &failing).expect_err("MERGE_HEAD cannot be read");

    assert!(
        matches!(&error, StoreError::ConflictsUnreadable { merge, read }
            if matches!(**merge, StoreError::Git { ref arguments, .. } if arguments.starts_with("merge"))
                && matches!(**read, StoreError::Git { ref arguments, .. } if arguments == "read MERGE_HEAD")),
        "{error:?}"
    );
    assert!(!desktop.join(".git/MERGE_HEAD").exists());
    assert_eq!(
        fs::read_to_string(desktop.join(TICKET)).expect("read the ticket"),
        LOCAL_EDIT
    );
    assert!(NETWORK.with_borrow(|calls| !calls.iter().any(|call| call.starts_with("push"))));
}

#[test]
fn a_failed_abort_after_a_conflict_names_the_conflict_and_the_abort() {
    let machines = machines_in_conflict();
    let desktop = machines.desktop();
    FAIL_GIT.set(vec!["merge --abort"]);

    let error = sync(&desktop, &effects()).expect_err("the abort fails");

    assert!(
        matches!(&error, StoreError::MergeAbortFailed { cause, .. }
            if matches!(**cause, StoreError::Conflict { ref files, .. } if *files == [PathBuf::from(TICKET)])),
        "{error:?}"
    );
}

#[test]
fn a_conflict_is_saved_as_the_last_result() {
    let machines = machines_in_conflict();
    let desktop = machines.desktop();

    let error = sync(&desktop, &effects()).expect_err("the edits conflict");

    assert!(matches!(error, StoreError::Conflict { .. }), "{error:?}");
    let saved: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(desktop.join(".git/tikk-sync.json")).expect("read the saved result"),
    )
    .expect("the saved result is JSON");
    assert_eq!(saved["conflict"], serde_json::json!([TICKET]));
    assert_eq!(saved["error"], serde_json::json!(error.to_string()));
}

#[test]
fn a_pending_file_that_blocks_the_merge_is_refused_and_nothing_is_pushed() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    let broken = "---\nkind: [\n---\n";
    write(&desktop, "tickets/personal/personal-efgh-mail.md", broken);
    NETWORK.set(Vec::new());

    let error = sync(&desktop, &effects()).expect_err("Git refuses the merge");

    assert!(
        matches!(&error, StoreError::MergeBlocked { message } if message.contains("would be overwritten by merge")),
        "{error:?}"
    );
    assert!(!desktop.join(".git/MERGE_HEAD").exists());
    assert_eq!(
        fs::read_to_string(desktop.join("tickets/personal/personal-efgh-mail.md"))
            .expect("read the pending file"),
        broken
    );
    assert!(NETWORK.with_borrow(|calls| !calls.iter().any(|call| call.starts_with("push"))));
}

#[test]
fn a_ticket_scan_that_fails_after_the_merge_is_a_merge_problem_and_sync_pushes() {
    let machines = machines_with_work();
    let (laptop, desktop) = (machines.laptop(), machines.desktop());
    dangling_ticket_link(&laptop);
    git_text(
        &laptop,
        &["add", "--", "tickets/personal/personal-zzzz-link.md"],
    );
    git_text(&laptop, &["commit", "--quiet", "--message", "Add a link"]);
    git_text(&laptop, &["push", "--quiet", "origin", "main"]);
    write(
        &desktop,
        "tickets/personal/personal-wxyz-new.md",
        TICKET_TEXT,
    );

    let outcome = sync(&desktop, &effects()).expect("a failed scan after the merge is a result");

    assert!(
        outcome.committed && outcome.merged && outcome.pushed,
        "{outcome:?}"
    );
    assert_eq!(outcome.problems.len(), 1, "{outcome:?}");
    assert_eq!(outcome.problems[0].step, SyncStep::Merge);
    assert!(
        outcome.problems[0]
            .message
            .contains("personal-zzzz-link.md"),
        "{outcome:?}"
    );
    assert_eq!(
        git_text(&laptop, &["ls-remote", "origin", "main"])
            .split('\t')
            .next(),
        Some(git_text(&desktop, &["rev-parse", "HEAD"]).trim())
    );
}

#[test]
fn the_clash_list_holds_a_clash_that_the_merge_brings() {
    let machines = machines_with_work();
    let (laptop, desktop) = (machines.laptop(), machines.desktop());
    let copy = "tickets/personal/personal-abcd-copy.md";
    write(&laptop, copy, TICKET_TEXT);
    sync(&laptop, &effects()).expect("the laptop pushes the copy");

    let outcome = sync(&desktop, &effects()).expect("a clash does not stop sync");

    assert!(outcome.merged, "{outcome:?}");
    assert_eq!(
        outcome.clashes,
        [IdClash {
            id: TicketId::parse("personal-abcd").expect("a valid ID"),
            paths: vec![PathBuf::from(copy), PathBuf::from(TICKET)],
        }]
    );
}
