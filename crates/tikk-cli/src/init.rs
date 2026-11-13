use std::path::Path;

use serde_json::json;
use tikk_core::{InitOutcome, MachineName, RemoteInitEffects, StoreEffects, StoreError};

use crate::output::Output;

pub(crate) fn run(
    store: &Path,
    machine: Option<MachineName>,
    effects: &StoreEffects,
) -> Result<Output, StoreError> {
    tikk_core::init(store, machine, effects).map(|outcome| init_output(&outcome))
}

pub(crate) fn run_remote(
    store: &Path,
    remote: &RemoteLocation,
    machine: Option<MachineName>,
    effects: &RemoteInitEffects,
) -> Result<Output, StoreError> {
    tikk_core::init_from_remote(store, &remote.0, machine, effects)
        .map(|outcome| init_output(&outcome))
}

/// A remote as Git reads it, with a relative local path made absolute.
pub(crate) struct RemoteLocation(String);

impl RemoteLocation {
    /// Git runs inside the store, so a relative local path would resolve from there instead of
    /// from the caller. Git reads `scheme://` and `host:path`, with no slash before the colon, as
    /// URLs.
    pub(crate) fn resolve(remote: &str, working_directory: &Path) -> Result<Self, StoreError> {
        if is_url(remote) || Path::new(remote).is_absolute() {
            return Ok(Self(remote.to_owned()));
        }

        working_directory
            .join(remote)
            .into_os_string()
            .into_string()
            .map(Self)
            .map_err(|_| StoreError::Git {
                arguments: "init --remote".to_owned(),
                message: "the working directory is not UTF-8, so the remote path cannot be passed \
                          to Git"
                    .to_owned(),
            })
    }
}

fn is_url(remote: &str) -> bool {
    let before_colon = remote.split_once(':').map(|(head, _)| head);

    remote.contains("://") || before_colon.is_some_and(|head| !head.contains('/'))
}

fn init_output(outcome: &InitOutcome) -> Output {
    let path = outcome.store.to_string_lossy();
    let text = if outcome.created {
        format!("Created the tikk store at {path}.")
    } else {
        format!("The tikk store already exists at {path}.")
    };

    Output {
        json: json!({ "store": path, "created": outcome.created }),
        text,
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::RemoteLocation;

    fn resolved(remote: &str) -> String {
        RemoteLocation::resolve(remote, Path::new("/home/user/work"))
            .expect("the remote resolves")
            .0
    }

    #[test]
    fn a_relative_local_path_resolves_from_the_working_directory() {
        assert_eq!(resolved("../remote.git"), "/home/user/work/../remote.git");
        assert_eq!(resolved("remote.git"), "/home/user/work/remote.git");
        assert_eq!(
            resolved("./a:b/remote.git"),
            "/home/user/work/./a:b/remote.git"
        );
    }

    #[test]
    fn a_working_directory_that_is_not_utf8_gives_a_git_error() {
        use std::os::unix::ffi::OsStrExt as _;

        let working_directory = Path::new(std::ffi::OsStr::from_bytes(b"/home/\xff"));

        let result = RemoteLocation::resolve("remote.git", working_directory);

        assert!(
            matches!(&result, Err(tikk_core::StoreError::Git { arguments, .. }) if arguments == "init --remote"),
            "{:?}",
            result.as_ref().map(|remote| &remote.0)
        );
    }

    #[test]
    fn urls_and_absolute_paths_stay_as_given() {
        assert_eq!(resolved("/srv/remote.git"), "/srv/remote.git");
        assert_eq!(
            resolved("https://host/remote.git"),
            "https://host/remote.git"
        );
        assert_eq!(resolved("file:///srv/remote.git"), "file:///srv/remote.git");
        assert_eq!(
            resolved("git@host:owner/remote.git"),
            "git@host:owner/remote.git"
        );
        assert_eq!(resolved("host:remote.git"), "host:remote.git");
    }
}
