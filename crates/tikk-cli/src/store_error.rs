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
        StoreError::NoEditor => ("noEditor", Exit::Refused),
        StoreError::EditorFailed { .. } => ("editorFailed", Exit::Refused),
        StoreError::Io { .. } => ("ioFailed", Exit::Refused),
    };
    let field = match error {
        StoreError::Ticket(TicketError::Invalid { field, .. }) => Some(field.clone()),
        _ => None,
    };

    Failure {
        code,
        message: error.to_string(),
        field,
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
            (StoreError::NoEditor, "noEditor", Exit::Refused),
            (
                StoreError::EditorFailed {
                    message: "it ended with exit status: 1".to_owned(),
                },
                "editorFailed",
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
        ];

        for (error, code, exit) in cases {
            let mapped = failure(&error);

            assert_eq!((mapped.code, mapped.exit), (code, exit), "case {error:?}");
        }
    }

    #[test]
    fn only_a_validation_error_names_a_field() {
        let invalid = StoreError::Ticket(TicketError::Invalid {
            field: "criteria[0].id".to_owned(),
            problem: "is required".to_owned(),
        });
        let not_found = StoreError::NotFound {
            id: "personal-abcd".to_owned(),
        };

        assert_eq!(failure(&invalid).field.as_deref(), Some("criteria[0].id"));
        assert_eq!(failure(&not_found).field, None);
    }
}
