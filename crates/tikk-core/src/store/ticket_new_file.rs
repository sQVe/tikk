use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

use crate::store::StoreError;
use crate::store::ticket_files::io_error;

pub(crate) fn write_bytes(file: &mut fs::File, bytes: &[u8]) -> io::Result<()> {
    file.write_all(bytes)
}

/// Writes the text to a temporary file in the same folder, then links it to `path`. A failed
/// write leaves neither file, and the link never replaces an existing file.
pub(crate) fn write_new_file(
    folder: &Path,
    path: &Path,
    text: &str,
    write: fn(&mut fs::File, &[u8]) -> io::Result<()>,
) -> Result<(), StoreError> {
    fs::create_dir_all(folder).map_err(|source| io_error("create", folder, source))?;

    let temporary = temporary_path(path);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|source| io_error("create", &temporary, source))?;
    let written = write(&mut file, text.as_bytes())
        .map_err(|source| io_error("write", path, source))
        .and_then(|()| {
            fs::hard_link(&temporary, path).map_err(|source| io_error("create", path, source))
        });

    drop(file);
    fs::remove_file(&temporary).map_err(|source| io_error("remove", &temporary, source))?;

    written
}

/// A dot name with a `.tmp` end, so no read takes it for a ticket file.
fn temporary_path(path: &Path) -> PathBuf {
    let name = path.file_name().unwrap_or_default().to_string_lossy();

    path.with_file_name(format!(".{name}.tmp"))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::{self, Write as _};
    use std::path::Path;

    use super::{write_bytes, write_new_file};
    use crate::store::StoreError;

    fn write_a_prefix_then_fail(file: &mut fs::File, bytes: &[u8]) -> io::Result<()> {
        file.write_all(&bytes[..3])?;

        Err(io::Error::other("disk full"))
    }

    fn entries(folder: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(folder)
            .expect("list the folder")
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
    fn write_new_file_writes_the_text() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let folder = directory.path().join("personal");
        let path = folder.join("personal-abcd-plan.md");

        write_new_file(&folder, &path, "---\nkind: plan\n---\n", write_bytes)
            .expect("the file is written");

        assert_eq!(
            fs::read_to_string(&path).expect("read the file"),
            "---\nkind: plan\n---\n"
        );
        assert_eq!(entries(&folder), ["personal-abcd-plan.md"]);
    }

    #[test]
    fn a_failed_write_leaves_no_ticket_file_and_no_temporary_file() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let folder = directory.path().join("personal");
        let path = folder.join("personal-abcd-plan.md");

        let error = write_new_file(
            &folder,
            &path,
            "---\nkind: plan\n---\n",
            write_a_prefix_then_fail,
        )
        .expect_err("the write fails");

        assert!(
            matches!(&error, StoreError::Io { action: "write", path: failed, .. } if *failed == path),
            "{error:?}"
        );
        assert_eq!(entries(&folder), Vec::<String>::new());
    }

    #[test]
    fn write_new_file_never_replaces_an_existing_file() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let folder = directory.path().join("personal");
        let path = folder.join("personal-abcd-plan.md");
        fs::create_dir(&folder).expect("create the folder");
        fs::write(&path, "mine").expect("write an existing file");

        let error =
            write_new_file(&folder, &path, "new text", write_bytes).expect_err("the file exists");

        assert!(matches!(&error, StoreError::Io { .. }), "{error:?}");
        assert_eq!(fs::read_to_string(&path).expect("read the file"), "mine");
        assert_eq!(entries(&folder), ["personal-abcd-plan.md"]);
    }
}
