use tikk_core::{StoreError, TicketError};

use crate::output::{Exit, Failure};

pub(crate) fn failure(error: &StoreError) -> Failure {
    let (code, exit) = match error {
        StoreError::NotInitialized { .. } => ("notInitialized", Exit::Refused),
        StoreError::FolderNotEmpty { .. } => ("folderNotEmpty", Exit::Refused),
        StoreError::InvalidConfig { .. } => ("invalidConfig", Exit::Refused),
        StoreError::ForeignRepository { .. } => ("foreignRepository", Exit::Refused),
        StoreError::NoStorePath => ("noStorePath", Exit::Refused),
        StoreError::InvalidMachineName { .. } => ("invalidArguments", Exit::WrongUsage),
        StoreError::InvalidHostName { .. } => ("invalidHostName", Exit::Refused),
        StoreError::HostNameUnavailable { .. } => ("hostNameUnavailable", Exit::Refused),
        StoreError::Git { .. } => ("gitFailed", Exit::Refused),
        StoreError::Ticket(error) => ticket_code(error),
        StoreError::TicketParse { .. } => ("parseError", Exit::Refused),
        StoreError::NotFound { .. } => ("notFound", Exit::Refused),
        StoreError::IdShared { .. } => ("idShared", Exit::Refused),
        StoreError::InvalidOrigin { .. } => ("invalidOrigin", Exit::Refused),
        StoreError::NoFreeId { .. } => ("noFreeId", Exit::Refused),
        StoreError::RandomUnavailable { .. } => ("randomUnavailable", Exit::Refused),
        StoreError::Locked { .. } => ("locked", Exit::Refused),
        StoreError::ChangedOnDisk { .. } => ("changedOnDisk", Exit::Refused),
        StoreError::WrongKind { .. } => ("wrongKind", Exit::Refused),
        StoreError::Cycle { .. } => ("cycle", Exit::Refused),
        StoreError::NotSibling { .. } => ("notSibling", Exit::Refused),
        StoreError::NoEditor => ("noEditor", Exit::Refused),
        StoreError::EditorFailed { .. } => ("editorFailed", Exit::Refused),
        StoreError::NoAgent => ("noTikkAgent", Exit::Refused),
        StoreError::NotUnicode { .. } => ("invalidArguments", Exit::WrongUsage),
        StoreError::Claimed { .. } => ("claimed", Exit::Refused),
        StoreError::Io { .. } => ("ioFailed", Exit::Refused),
        StoreError::GitTimeout { .. } => ("gitTimeout", Exit::Refused),
        StoreError::Conflict { .. } => ("conflict", Exit::Refused),
        StoreError::ConflictsUnreadable { .. } => ("conflictsUnreadable", Exit::Refused),
        StoreError::MergeAbortFailed { .. } => ("mergeAbortFailed", Exit::Refused),
        StoreError::MergeBlocked { .. } => ("mergeBlocked", Exit::Refused),
        StoreError::UnstageFailed { .. } => ("unstageFailed", Exit::Refused),
        StoreError::MergeInProgress { .. } => ("mergeInProgress", Exit::Refused),
        StoreError::StagedChanges { .. } => ("stagedChanges", Exit::Refused),
        StoreError::NotOnMain { .. } => ("notOnMain", Exit::Refused),
        StoreError::FactRewritten { .. } => ("factRewritten", Exit::Refused),
        StoreError::RemoteWithoutMain { .. } => ("remoteWithoutMain", Exit::Refused),
        StoreError::RemoteNotAStore { .. } => ("remoteNotAStore", Exit::Refused),
        StoreError::MachineInUse { .. } => ("machineInUse", Exit::Refused),
        StoreError::ResultNotSaved { error: inner, .. } => {
            return Failure {
                message: error.to_string(),
                ..failure(inner)
            };
        }
    };
    let field = match error {
        StoreError::Ticket(TicketError::Invalid { field, .. }) => Some(field.clone()),
        StoreError::Cycle { field, .. } => Some((*field).to_owned()),
        _ => None,
    };

    let files = match error {
        StoreError::Conflict { files, .. } => Some(
            files
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
        ),
        _ => None,
    };

    Failure {
        code,
        message: error.to_string(),
        field,
        files,
        exit,
    }
}

fn ticket_code(error: &TicketError) -> (&'static str, Exit) {
    match error {
        TicketError::Invalid { .. } => ("invalidTicket", Exit::Refused),
        TicketError::Parse { .. } => ("parseError", Exit::Refused),
        TicketError::InvalidProject { .. }
        | TicketError::InvalidId { .. }
        | TicketError::InvalidKind { .. }
        | TicketError::InvalidStatus { .. } => ("invalidArguments", Exit::WrongUsage),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::{Value, json};
    use tikk_core::{Kind, StoreError, TicketError};

    use super::failure;
    use crate::output::{Exit, Response};

    #[test]
    fn not_initialized_prints_an_error_object_and_exits_with_1() {
        let error = StoreError::NotInitialized {
            store: PathBuf::from("/tmp/store"),
        };

        let response = Response::failure(true, &failure(&error));

        assert_eq!(response.stdout, "");
        assert_eq!(response.exit, Exit::Refused);
        let printed: Value =
            serde_json::from_str(&response.stderr).expect("the error is one JSON value");
        assert_eq!(printed["error"]["code"], json!("notInitialized"));
        assert_eq!(printed["error"]["message"], json!(error.to_string()));
    }

    #[test]
    fn each_error_maps_to_its_code_and_exit() {
        let cases = [
            (
                StoreError::FolderNotEmpty {
                    store: PathBuf::from("/tmp/store"),
                },
                "folderNotEmpty",
                Exit::Refused,
            ),
            (
                StoreError::InvalidConfig {
                    path: PathBuf::from("/tmp/store/tikk.json"),
                },
                "invalidConfig",
                Exit::Refused,
            ),
            (
                StoreError::ForeignRepository {
                    store: PathBuf::from("/tmp/store"),
                },
                "foreignRepository",
                Exit::Refused,
            ),
            (StoreError::NoStorePath, "noStorePath", Exit::Refused),
            (
                StoreError::InvalidMachineName {
                    name: "A".to_owned(),
                    reason: "uppercase",
                },
                "invalidArguments",
                Exit::WrongUsage,
            ),
            (
                StoreError::InvalidHostName {
                    host_name: "a_b".to_owned(),
                },
                "invalidHostName",
                Exit::Refused,
            ),
            (
                StoreError::HostNameUnavailable {
                    message: "no uname".to_owned(),
                },
                "hostNameUnavailable",
                Exit::Refused,
            ),
            (
                StoreError::Git {
                    arguments: "init".to_owned(),
                    message: "failed".to_owned(),
                },
                "gitFailed",
                Exit::Refused,
            ),
            (
                StoreError::Ticket(TicketError::Invalid {
                    field: "parent".to_owned(),
                    problem: "is wrong".to_owned(),
                }),
                "invalidTicket",
                Exit::Refused,
            ),
            (
                StoreError::Ticket(TicketError::Parse {
                    message: "broken".to_owned(),
                }),
                "parseError",
                Exit::Refused,
            ),
            (
                StoreError::Ticket(TicketError::InvalidId {
                    value: "x".to_owned(),
                    reason: "bad",
                }),
                "invalidArguments",
                Exit::WrongUsage,
            ),
            (
                StoreError::Ticket(TicketError::InvalidProject {
                    value: "X".to_owned(),
                    reason: "bad",
                }),
                "invalidArguments",
                Exit::WrongUsage,
            ),
            (
                StoreError::Ticket(TicketError::InvalidKind {
                    value: "epic".to_owned(),
                }),
                "invalidArguments",
                Exit::WrongUsage,
            ),
            (
                StoreError::Ticket(TicketError::InvalidStatus {
                    value: "closed".to_owned(),
                }),
                "invalidArguments",
                Exit::WrongUsage,
            ),
            (
                StoreError::TicketParse {
                    path: PathBuf::from("/tmp/store/tickets/personal/personal-abcd.md"),
                    message: "broken".to_owned(),
                },
                "parseError",
                Exit::Refused,
            ),
            (
                StoreError::NotFound {
                    id: "personal-abcd".to_owned(),
                },
                "notFound",
                Exit::Refused,
            ),
            (
                StoreError::IdShared {
                    id: "personal-abcd".to_owned(),
                    paths: Vec::new(),
                },
                "idShared",
                Exit::Refused,
            ),
            (
                StoreError::InvalidOrigin {
                    url: "git@github.com:o/my_app.git".to_owned(),
                },
                "invalidOrigin",
                Exit::Refused,
            ),
            (
                StoreError::NoFreeId {
                    project: "personal".to_owned(),
                },
                "noFreeId",
                Exit::Refused,
            ),
            (
                StoreError::RandomUnavailable {
                    message: "no source".to_owned(),
                },
                "randomUnavailable",
                Exit::Refused,
            ),
            (
                StoreError::Locked {
                    lock: PathBuf::from("/tmp/store/.git/tikk.lock"),
                },
                "locked",
                Exit::Refused,
            ),
            (
                StoreError::ChangedOnDisk {
                    path: PathBuf::from("/tmp/store/tickets/personal/personal-abcd-a.md"),
                },
                "changedOnDisk",
                Exit::Refused,
            ),
            (
                StoreError::WrongKind {
                    id: "personal-abcd".to_owned(),
                    kind: Kind::Plan,
                    allowed: "a task or an instruction",
                },
                "wrongKind",
                Exit::Refused,
            ),
            (
                StoreError::Cycle {
                    field: "blockedBy",
                    steps: Vec::new(),
                },
                "cycle",
                Exit::Refused,
            ),
            (
                StoreError::NotSibling {
                    id: "personal-abcd".to_owned(),
                    anchor: "personal-efgh".to_owned(),
                },
                "notSibling",
                Exit::Refused,
            ),
            (StoreError::NoEditor, "noEditor", Exit::Refused),
            (
                StoreError::EditorFailed {
                    message: "it ended with exit status: 1".to_owned(),
                },
                "editorFailed",
                Exit::Refused,
            ),
            (StoreError::NoAgent, "noTikkAgent", Exit::Refused),
            (
                StoreError::NotUnicode {
                    variable: "TIKK_AGENT",
                },
                "invalidArguments",
                Exit::WrongUsage,
            ),
            (
                StoreError::Claimed {
                    id: "personal-abcd".to_owned(),
                    agent: "manager".to_owned(),
                    lease_end: "2026-11-13T05:00:00.000Z".to_owned(),
                },
                "claimed",
                Exit::Refused,
            ),
            (
                StoreError::Io {
                    action: "write",
                    path: PathBuf::from("/tmp/store/tikk.json"),
                    source: std::io::Error::other("disk full"),
                },
                "ioFailed",
                Exit::Refused,
            ),
            (
                StoreError::GitTimeout {
                    arguments: "fetch".to_owned(),
                    timeout: std::time::Duration::from_secs(30),
                },
                "gitTimeout",
                Exit::Refused,
            ),
            (conflict(), "conflict", Exit::Refused),
            (
                StoreError::ConflictsUnreadable {
                    merge: Box::new(git_failure("merge")),
                    read: Box::new(git_failure("diff")),
                },
                "conflictsUnreadable",
                Exit::Refused,
            ),
            (
                StoreError::MergeAbortFailed {
                    store: PathBuf::from("/tmp/store"),
                    cause: Box::new(conflict()),
                    abort: Box::new(git_failure("merge --abort")),
                },
                "mergeAbortFailed",
                Exit::Refused,
            ),
            (
                StoreError::UnstageFailed {
                    store: PathBuf::from("/tmp/store"),
                    cause: Box::new(git_failure("commit")),
                    unstage: Box::new(git_failure("reset")),
                },
                "unstageFailed",
                Exit::Refused,
            ),
            (
                StoreError::MergeBlocked {
                    message: "would be overwritten".to_owned(),
                },
                "mergeBlocked",
                Exit::Refused,
            ),
            (
                StoreError::MergeInProgress {
                    store: PathBuf::from("/tmp/store"),
                },
                "mergeInProgress",
                Exit::Refused,
            ),
            (
                StoreError::StagedChanges {
                    store: PathBuf::from("/tmp/store"),
                    paths: vec![PathBuf::from("notes.txt")],
                },
                "stagedChanges",
                Exit::Refused,
            ),
            (
                StoreError::NotOnMain {
                    store: PathBuf::from("/tmp/store"),
                    branch: "refs/heads/work".to_owned(),
                },
                "notOnMain",
                Exit::Refused,
            ),
            (
                StoreError::FactRewritten {
                    path: PathBuf::from("/tmp/store/facts/laptop/2026-11.jsonl"),
                },
                "factRewritten",
                Exit::Refused,
            ),
            (
                StoreError::RemoteWithoutMain {
                    url: "/tmp/remote.git".to_owned(),
                },
                "remoteWithoutMain",
                Exit::Refused,
            ),
            (
                StoreError::RemoteNotAStore {
                    url: "/tmp/remote.git".to_owned(),
                },
                "remoteNotAStore",
                Exit::Refused,
            ),
            (
                StoreError::MachineInUse {
                    machine: "laptop".to_owned(),
                },
                "machineInUse",
                Exit::Refused,
            ),
        ];

        for (error, code, exit) in cases {
            let mapped = failure(&error);

            assert_eq!((mapped.code, mapped.exit), (code, exit), "case {error:?}");
        }
    }

    fn git_failure(arguments: &str) -> StoreError {
        StoreError::Git {
            arguments: arguments.to_owned(),
            message: "failed".to_owned(),
        }
    }

    fn conflict() -> StoreError {
        StoreError::Conflict {
            store: PathBuf::from("/tmp/store"),
            files: vec![PathBuf::from("tickets/personal/personal-abcd-a.md")],
        }
    }

    #[test]
    fn only_a_conflict_lists_files() {
        assert_eq!(
            failure(&conflict()).files,
            Some(vec!["tickets/personal/personal-abcd-a.md".to_owned()])
        );
        assert_eq!(failure(&git_failure("merge")).files, None);
    }

    #[test]
    fn an_unsaved_result_keeps_the_code_and_files_of_the_sync_error() {
        let error = StoreError::ResultNotSaved {
            error: Box::new(conflict()),
            save: Box::new(StoreError::Io {
                action: "replace",
                path: PathBuf::from("/tmp/store/.git/tikk-sync.json"),
                source: std::io::Error::other("disk full"),
            }),
        };

        let mapped = failure(&error);

        assert_eq!((mapped.code, mapped.exit), ("conflict", Exit::Refused));
        assert_eq!(mapped.files, failure(&conflict()).files);
        assert_eq!(mapped.message, error.to_string());
        assert!(mapped.message.contains("disk full"), "{}", mapped.message);
    }

    #[test]
    fn only_a_validation_error_and_a_cycle_name_a_field() {
        let invalid = StoreError::Ticket(TicketError::Invalid {
            field: "criteria[0].id".to_owned(),
            problem: "is required".to_owned(),
        });
        let cycle = StoreError::Cycle {
            field: "parent",
            steps: Vec::new(),
        };
        let not_found = StoreError::NotFound {
            id: "personal-abcd".to_owned(),
        };

        assert_eq!(failure(&invalid).field.as_deref(), Some("criteria[0].id"));
        assert_eq!(failure(&cycle).field.as_deref(), Some("parent"));
        assert_eq!(failure(&not_found).field, None);
    }
}
