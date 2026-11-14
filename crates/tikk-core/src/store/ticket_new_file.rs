use std::fs;
use std::io::{self, Write as _};
use std::path::Path;

use tempfile::NamedTempFile;

use crate::store::StoreError;
use crate::store::ticket_files::io_error;

pub(crate) fn write_bytes(file: &mut fs::File, bytes: &[u8]) -> io::Result<()> {
    file.write_all(bytes)
}

pub(crate) fn write_new_file(
    folder: &Path,
    path: &Path,
    text: &str,
    write: fn(&mut fs::File, &[u8]) -> io::Result<()>,
) -> Result<(), StoreError> {
    fs::create_dir_all(folder).map_err(|source| io_error("create", folder, source))?;

    // The temporary file is removed when dropped, so a failed write leaves no file behind.
    let mut temporary =
        NamedTempFile::new_in(folder).map_err(|source| io_error("create", folder, source))?;

    write(temporary.as_file_mut(), text.as_bytes())
        .map_err(|source| io_error("write", path, source))?;
    temporary
        .persist_noclobber(path)
        .map_err(|error| io_error("create", path, error.error))?;

    Ok(())
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
