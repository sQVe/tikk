use std::fs;
use std::path::PathBuf;

use super::{
    CLOCK, Machines, TICKET, TICKET_TEXT, effects, git_text, later, machines_with_work, sync, write,
};
use crate::store::sync::{PendingFile, PendingReason, SyncOutcome, SyncProblem, SyncStep};
use crate::store::{IdClash, StoreError};
use crate::ticket::TicketId;

#[test]
fn a_result_that_cannot_be_saved_is_a_problem_or_joins_the_error() {
    let machines = machines_with_work();
    let desktop = machines.desktop();
    let result_file = desktop.join(".git/tikk-sync.json");
    fs::remove_file(&result_file).expect("remove the earlier result");
    fs::create_dir_all(result_file.join("held")).expect("block the result file with a folder");

    let outcome = sync(&desktop, &effects()).expect("the sync itself works");
    write(&desktop, "notes.txt", "mine\n");
    git_text(&desktop, &["add", "notes.txt"]);
    let error = sync(&desktop, &effects()).expect_err("a staged file is refused");

    assert!(outcome.merged, "{outcome:?}");
    assert_eq!(
        outcome.problems.last().map(|problem| problem.step),
        Some(SyncStep::Save)
    );
    assert!(
        matches!(&error, StoreError::ResultNotSaved { error, save }
            if matches!(**error, StoreError::StagedChanges { .. })
                && matches!(**save, StoreError::Io { action: "replace", .. })),
        "{error:?}"
    );
}

#[test]
fn the_outcome_names_each_reason_and_step_in_camel_case() {
    let pending = |path: &str, reason| PendingFile {
        path: path.to_owned(),
        reason,
    };
    let problem = |step| SyncProblem::new(step, "failed".to_owned());
    let outcome = SyncOutcome {
        committed: false,
        committed_paths: Vec::new(),
        pending: vec![
            pending("a", PendingReason::Settling),
            pending("b", PendingReason::Unparsed),
            pending("c", PendingReason::NameNotUtf8),
        ],
        fetched: false,
        merged: false,
        pushed: false,
        problems: vec![
            problem(SyncStep::Fetch),
            SyncProblem {
                files: vec!["d".to_owned()],
                ..problem(SyncStep::Merge)
            },
            problem(SyncStep::Commit),
            problem(SyncStep::Push),
            problem(SyncStep::Save),
        ],
        clashes: vec![IdClash {
            id: TicketId::parse("personal-abcd").expect("a valid ID"),
            paths: vec![PathBuf::from("e"), PathBuf::from("f")],
        }],
    };

    let json = serde_json::to_value(&outcome).expect("the outcome serializes");

    assert_eq!(
        json["pending"],
        serde_json::json!([
            { "path": "a", "reason": "settling" },
            { "path": "b", "reason": "unparsed" },
            { "path": "c", "reason": "nameNotUtf8" },
        ])
    );
    assert_eq!(
        json["problems"],
        serde_json::json!([
            { "step": "fetch", "message": "failed" },
            { "step": "merge", "message": "failed", "files": ["d"] },
            { "step": "commit", "message": "failed" },
            { "step": "push", "message": "failed" },
            { "step": "save", "message": "failed" },
        ])
    );
    assert_eq!(
        json["clashes"],
        serde_json::json!([{ "id": "personal-abcd", "paths": ["e", "f"] }])
    );
}

#[test]
fn sync_lists_each_id_clash_with_relative_paths_and_saves_the_outcome() {
    let machines = Machines::new();
    let laptop = machines.laptop();
    let copy = "tickets/personal/personal-abcd-copy.md";
    CLOCK.set(later());
    write(&laptop, TICKET, TICKET_TEXT);
    write(&laptop, copy, TICKET_TEXT);

    let outcome = sync(&laptop, &effects()).expect("a clash does not stop sync");

    assert_eq!(
        outcome.clashes,
        [IdClash {
            id: TicketId::parse("personal-abcd").expect("a valid ID"),
            paths: vec![PathBuf::from(copy), PathBuf::from(TICKET)],
        }]
    );
    let mut saved: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(laptop.join(".git/tikk-sync.json")).expect("read the saved result"),
    )
    .expect("the saved result is JSON");
    assert!(saved["at"].is_string(), "{saved}");
    saved
        .as_object_mut()
        .expect("the saved result is an object")
        .remove("at");
    assert_eq!(
        saved,
        serde_json::to_value(&outcome).expect("the outcome serializes")
    );
}
