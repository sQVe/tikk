use std::fs;
use std::io::{self, Write as _};
use std::path::Path;

use crate::store::StoreError;
use crate::store::ticket_files::{io_error, sha256_hex};

pub(crate) fn replace_ticket_file(
    path: &Path,
    text: &str,
    expected_hash: &str,
) -> Result<(), StoreError> {
    replace_ticket_file_with(path, text, expected_hash, |path| fs::read(path))
}

fn replace_ticket_file_with(
    path: &Path,
    text: &str,
    expected_hash: &str,
    read_current: fn(&Path) -> io::Result<Vec<u8>>,
) -> Result<(), StoreError> {
    let folder = path.parent().unwrap_or(Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(folder)
        .map_err(|source| io_error("create", folder, source))?;
    let temporary_path = temporary.path().to_path_buf();

    let permissions = match fs::metadata(path) {
        Ok(metadata) => metadata.permissions(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(changed_on_disk(path));
        }
        Err(source) => return Err(io_error("check", path, source)),
    };

    temporary
        .write_all(text.as_bytes())
        .and_then(|()| temporary.as_file().set_permissions(permissions))
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|source| io_error("write", &temporary_path, source))?;

    // Only the rename follows this check. A program outside tikk that saves the file in between
    // can still lose its save, since a rename cannot compare and swap.
    let current = match read_current(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(changed_on_disk(path));
        }
        Err(source) => return Err(io_error("read", path, source)),
    };

    if sha256_hex(&current) != expected_hash {
        return Err(changed_on_disk(path));
    }

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

    use std::cell::RefCell;
    use std::io;
    use std::path::Path;

    use super::{replace_ticket_file, replace_ticket_file_with};
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

    thread_local! {
        static AT_CHECK: RefCell<Vec<(String, u32)>> = const { RefCell::new(Vec::new()) };
    }

    // Records the text and mode of every other file in the folder when the final check reads.
    fn read_after_recording_the_temporary_file(path: &Path) -> io::Result<Vec<u8>> {
        let folder = path.parent().expect("the ticket is in a folder");

        for entry in fs::read_dir(folder)? {
            let other = entry?.path();

            if other != path {
                let text = fs::read_to_string(&other)?;
                let mode = fs::metadata(&other)?.permissions().mode() & 0o777;

                AT_CHECK.with(|seen| seen.borrow_mut().push((text, mode)));
            }
        }

        fs::read(path)
    }

    #[test]
    fn the_temporary_file_is_complete_before_the_final_hash_check() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let path = directory.path().join("personal-abcd-a.md");
        fs::write(&path, "old").expect("write the ticket");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("set the mode");

        replace_ticket_file_with(
            &path,
            "new",
            &sha256_hex(b"old"),
            read_after_recording_the_temporary_file,
        )
        .expect("the hash matches");

        assert_eq!(
            AT_CHECK.with(|seen| seen.take()),
            [("new".to_owned(), 0o644)]
        );
        assert_eq!(fs::read_to_string(&path).expect("read the ticket"), "new");
    }

    fn read_after_a_delete(_: &Path) -> io::Result<Vec<u8>> {
        Err(io::Error::from(io::ErrorKind::NotFound))
    }

    #[test]
    fn replace_refuses_a_file_deleted_before_the_final_check_and_writes_nothing() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let path = directory.path().join("personal-abcd-a.md");
        fs::write(&path, "old").expect("write the ticket");

        let error =
            replace_ticket_file_with(&path, "new", &sha256_hex(b"old"), read_after_a_delete)
                .expect_err("the file is gone at the check");

        assert!(
            matches!(&error, StoreError::ChangedOnDisk { path: found } if *found == path),
            "{error:?}"
        );
        assert_eq!(fs::read_to_string(&path).expect("read the ticket"), "old");
        assert_eq!(folder_names(directory.path()), ["personal-abcd-a.md"]);
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
