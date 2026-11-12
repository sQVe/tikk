use std::fs;
use std::io::{self, Write as _};
use std::path::Path;

use crate::store::StoreError;
use crate::store::ticket_files::{io_error, sha256_hex};

// The hash check runs right before the rename, so a hand edit since the read is kept.
pub(crate) fn replace_ticket_file(
    path: &Path,
    text: &str,
    expected_hash: &str,
) -> Result<(), StoreError> {
    let folder = path.parent().unwrap_or(Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(folder)
        .map_err(|source| io_error("create", folder, source))?;
    let temporary_path = temporary.path().to_path_buf();

    temporary
        .write_all(text.as_bytes())
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|source| io_error("write", &temporary_path, source))?;

    let current = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(changed_on_disk(path));
        }
        Err(source) => return Err(io_error("read", path, source)),
    };

    if sha256_hex(&current) != expected_hash {
        return Err(changed_on_disk(path));
    }

    let permissions = fs::metadata(path)
        .map_err(|source| io_error("check", path, source))?
        .permissions();

    fs::set_permissions(&temporary_path, permissions)
        .map_err(|source| io_error("write", &temporary_path, source))?;
    temporary
        .persist(path)
        .map_err(|error| io_error("rename", path, error.error))?;

    Ok(())
}

fn changed_on_disk(path: &Path) -> StoreError {
    StoreError::ChangedOnDisk {
        path: path.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt as _;

    use super::replace_ticket_file;
    use crate::store::StoreError;
    use crate::store::ticket_files::sha256_hex;

    fn folder_names(folder: &std::path::Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(folder)
            .expect("read the folder")
            .map(|entry| {
                entry
                    .expect("read an entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();

        names.sort();

        names
    }

    #[test]
    fn replace_writes_the_text_and_keeps_the_file_mode() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let path = directory.path().join("personal-abcd-a.md");
        fs::write(&path, "old").expect("write the ticket");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("set the mode");

        replace_ticket_file(&path, "new", &sha256_hex(b"old")).expect("the hash matches");

        assert_eq!(fs::read_to_string(&path).expect("read the ticket"), "new");
        let mode = fs::metadata(&path)
            .expect("read the mode")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o644);
        assert_eq!(folder_names(directory.path()), ["personal-abcd-a.md"]);
    }

    #[test]
    fn replace_refuses_a_changed_or_missing_file_and_leaves_no_temporary_file() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let changed = directory.path().join("personal-abcd-a.md");
        let missing = directory.path().join("personal-wxyz-b.md");
        fs::write(&changed, "edited by hand").expect("write the ticket");

        for path in [&changed, &missing] {
            let error = replace_ticket_file(path, "new", &sha256_hex(b"old"))
                .expect_err("the file is not the one that was read");

            assert!(
                matches!(&error, StoreError::ChangedOnDisk { path: found } if found == path),
                "case {}: {error:?}",
                path.display()
            );
        }
        assert_eq!(
            fs::read_to_string(&changed).expect("read the ticket"),
            "edited by hand"
        );
        assert_eq!(folder_names(directory.path()), ["personal-abcd-a.md"]);
    }

    #[test]
    fn replace_reports_a_read_error_that_is_not_a_missing_file() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let path = directory.path().join("personal-abcd-a.md");
        fs::create_dir(&path).expect("put a folder where the ticket file was");

        let error = replace_ticket_file(&path, "new", &sha256_hex(b"old"))
            .expect_err("a folder cannot be read as a file");

        assert!(
            matches!(&error, StoreError::Io { action: "read", path: found, .. } if *found == path),
            "{error:?}"
        );
        assert_eq!(folder_names(directory.path()), ["personal-abcd-a.md"]);
    }
}
