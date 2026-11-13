use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use super::{
    CHECKED, CLOCK, FACT, FACT_LINE, FAIL_GIT, Machines, TICKET, TICKET_TEXT, WAITED, effects,
    git_text, later, machines_with_work, snapshot, sync, write,
};
use crate::store::StoreError;
use crate::store::sync::{PendingFile, PendingReason, SyncEffects};

fn no_wait(duration: Duration) {
    WAITED.set(WAITED.get() + duration);
}

#[test]
fn a_young_file_is_committed_after_sync_waits_for_it_to_settle() {
    let machines = Machines::new();
    let laptop = machines.laptop();
    write(&laptop, TICKET, TICKET_TEXT);
    CLOCK.set(Some(SystemTime::now()));
    WAITED.set(Duration::ZERO);

    let outcome = sync(&laptop, &effects()).expect("sync runs");

    assert_eq!(outcome.committed_paths, [TICKET]);
    assert!(
        WAITED.get() > Duration::from_millis(1500),
        "{:?}",
        WAITED.get()
    );
    assert!(WAITED.get() <= Duration::from_secs(2), "{:?}", WAITED.get());
}

#[test]
fn a_file_still_young_after_the_wait_stays_pending_as_settling() {
    let machines = Machines::new();
    let laptop = machines.laptop();
    write(&laptop, TICKET, TICKET_TEXT);
    write(&laptop, FACT, FACT_LINE);
    CLOCK.set(Some(SystemTime::now()));
    let effects = SyncEffects {
        wait: no_wait,
        ..effects()
    };

    let outcome = sync(&laptop, &effects).expect("sync runs");

    assert_eq!(outcome.committed_paths, [FACT], "facts never wait");
    assert_eq!(
        outcome.pending,
        [PendingFile {
            path: TICKET.to_owned(),
            reason: PendingReason::Settling
        }]
    );
}

#[test]
fn sync_stages_the_bytes_it_checked_not_a_later_read_of_the_file() {
    let machines = Machines::new();
    let laptop = machines.laptop();
    write(
        &laptop,
        TICKET,
        "---\nkind: task\ntitle: Saved later\n---\n",
    );
    CLOCK.set(later());
    CHECKED.set(Some((
        PathBuf::from(TICKET),
        TICKET_TEXT.as_bytes().to_vec(),
    )));

    sync(&laptop, &effects()).expect("sync runs");

    assert_eq!(
        git_text(&laptop, &["show", &format!("HEAD:{TICKET}")]),
        TICKET_TEXT
    );
    assert_eq!(
        git_text(&laptop, &["status", "--porcelain"]),
        format!(" M {TICKET}\n")
    );
}

#[test]
fn a_deleted_ticket_is_committed_as_a_deletion() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    fs::remove_file(desktop.join(TICKET)).expect("delete a ticket by hand");

    let outcome = sync(&desktop, &effects()).expect("sync runs");

    assert!(
        outcome.committed_paths.contains(&TICKET.to_owned()),
        "{outcome:?}"
    );
    assert_eq!(
        git_text(&desktop, &["ls-tree", "--name-only", "HEAD", "--", TICKET]),
        ""
    );
    assert_eq!(git_text(&desktop, &["status", "--porcelain"]), "");
}

#[test]
fn a_failed_commit_unstages_what_sync_staged_and_the_next_sync_works() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    write(
        &desktop,
        "tickets/personal/personal-wxyz-new.md",
        TICKET_TEXT,
    );
    fs::remove_file(desktop.join(TICKET)).expect("delete a ticket by hand");
    let before = snapshot(&desktop);
    FAIL_GIT.set(vec!["commit"]);

    let error = sync(&desktop, &effects()).expect_err("the commit fails");
    let after_failure = snapshot(&desktop);
    FAIL_GIT.set(Vec::new());
    let next = sync(&desktop, &effects());

    assert!(
        matches!(&error, StoreError::Git { arguments, .. } if arguments.starts_with("commit")),
        "{error:?}"
    );
    assert_eq!(after_failure, before);
    let next = next.expect("the next sync works with no reset by hand");
    assert!(next.committed && next.merged, "{next:?}");
}

#[test]
fn a_failed_unstage_after_a_failed_commit_reports_both_errors() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    write(
        &desktop,
        "tickets/personal/personal-wxyz-new.md",
        TICKET_TEXT,
    );
    FAIL_GIT.set(vec!["commit", "--literal-pathspecs reset"]);

    let error = sync(&desktop, &effects()).expect_err("the commit and the unstage fail");

    assert!(
        matches!(&error, StoreError::UnstageFailed { cause, unstage, .. }
            if matches!(**cause, StoreError::Git { ref arguments, .. } if arguments.starts_with("commit"))
                && matches!(**unstage, StoreError::Git { ref arguments, .. } if arguments.starts_with("--literal-pathspecs reset"))),
        "{error:?}"
    );
}
