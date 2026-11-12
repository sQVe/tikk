use tikk_core::StoreError;

use crate::output::{Exit, Failure};

pub(crate) fn failure(error: &StoreError) -> Failure {
    let (code, exit) = match error {
        StoreError::NotInitialized { .. } => ("notInitialized", Exit::Refused),
        StoreError::FolderNotEmpty { .. } => ("folderNotEmpty", Exit::Refused),
        StoreError::InvalidConfig { .. } => ("invalidConfig", Exit::Refused),
        StoreError::NoStorePath => ("noStorePath", Exit::Refused),
        StoreError::InvalidMachineName { .. } => ("invalidArguments", Exit::WrongUsage),
        StoreError::InvalidHostName { .. } => ("invalidHostName", Exit::Refused),
        StoreError::HostNameUnavailable { .. } => ("hostNameUnavailable", Exit::Refused),
        StoreError::Git { .. } => ("gitFailed", Exit::Refused),
        StoreError::Io { .. } => ("ioFailed", Exit::Refused),
    };

    Failure {
        code,
        message: error.to_string(),
        exit,
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::{Value, json};
    use tikk_core::StoreError;

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
}
