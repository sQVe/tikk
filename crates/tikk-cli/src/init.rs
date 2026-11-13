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

pub(crate) struct RemoteLocation(String);

impl RemoteLocation {
    // Git runs inside the store, so a relative local path would resolve from there instead of
    // from the caller. A relative name that names no local folder stays as given, so Git can apply
    // a `url.<base>.insteadOf` rewrite. Git reads `scheme://` and `host:path`, with no slash
    // before the colon, as URLs.
    pub(crate) fn resolve(remote: &str, working_directory: &Path) -> Result<Self, StoreError> {
        let local_path = working_directory.join(remote);
        let names_no_local_folder = !local_path.exists();

        if is_url(remote) || names_no_local_folder {
            return Ok(Self(remote.to_owned()));
        }

        local_path
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

    fn resolved_in(remote: &str, working_directory: &Path) -> String {
        RemoteLocation::resolve(remote, working_directory)
            .expect("the remote resolves")
            .0
    }

    fn resolved(remote: &str) -> String {
        resolved_in(remote, Path::new("/home/user/work"))
    }

    #[test]
    fn a_relative_path_to_a_local_folder_resolves_from_the_working_directory() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let work = directory.path().join("work");
        std::fs::create_dir_all(&work).expect("create the working directory");
        std::fs::create_dir_all(directory.path().join("remote.git")).expect("create the remote");
        std::fs::create_dir_all(work.join("a:b/remote.git")).expect("create the remote");

        assert_eq!(
            resolved_in("../remote.git", &work),
            format!("{}/../remote.git", work.display())
        );
        assert_eq!(
            resolved_in("./a:b/remote.git", &work),
            format!("{}/./a:b/remote.git", work.display())
        );
    }

    #[test]
    fn a_relative_name_with_no_local_folder_stays_as_given_for_git_to_rewrite() {
        assert_eq!(resolved("alias/remote.git"), "alias/remote.git");
        assert_eq!(resolved("../remote.git"), "../remote.git");
    }

    #[test]
    fn a_working_directory_that_is_not_utf8_gives_a_git_error() {
        use std::os::unix::ffi::OsStrExt as _;

        let directory = tempfile::tempdir().expect("create a temporary directory");
        let working_directory = directory.path().join(std::ffi::OsStr::from_bytes(b"\xff"));
        // macOS refuses a file name that is not UTF-8, so there a working directory like this
        // cannot exist.
        let illegal_byte_sequence = 92;
        if let Err(error) = std::fs::create_dir_all(working_directory.join("remote.git")) {
            assert_eq!(error.raw_os_error(), Some(illegal_byte_sequence), "{error}");

            return;
        }

        let result = RemoteLocation::resolve("remote.git", &working_directory);

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
