use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::store::StoreError;
use crate::ticket::{ProjectName, TicketDocument, TicketId};

pub(crate) const TICKETS_FOLDER: &str = "tickets";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredTicket {
    pub id: TicketId,
    pub path: PathBuf,
    /// The SHA-256 of the file's bytes, as lowercase hex.
    pub hash: String,
    pub text: String,
    pub document: TicketDocument,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnreadableTicket {
    pub path: PathBuf,
    pub id: Option<TicketId>,
    pub message: String,
}

#[derive(Debug, Default)]
pub(crate) struct TicketScan {
    pub(crate) tickets: Vec<StoredTicket>,
    pub(crate) errors: Vec<UnreadableTicket>,
}

pub(crate) fn read_tickets(root: &Path) -> Result<TicketScan, StoreError> {
    let mut scan = TicketScan::default();
    let folder = root.join(TICKETS_FOLDER);

    if !exists(&folder)? {
        return Ok(scan);
    }

    for path in sorted_entries(&folder)? {
        if !is_folder(&path)? {
            continue;
        }

        let name = path.file_name().unwrap_or_default().to_string_lossy();

        match ProjectName::parse(&name) {
            Ok(project) => read_project(&path, &project, &mut scan)?,
            Err(error) => scan.errors.push(UnreadableTicket {
                path,
                id: None,
                message: format!("the folder is not a project: {error}"),
            }),
        }
    }

    Ok(scan)
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn sorted_entries(folder: &Path) -> Result<Vec<PathBuf>, StoreError> {
    let entries = fs::read_dir(folder).map_err(|source| io_error("list", folder, source))?;
    let mut paths = entries
        .map(|entry| {
            entry
                .map(|entry| entry.path())
                .map_err(|source| io_error("list", folder, source))
        })
        .collect::<Result<Vec<_>, _>>()?;

    paths.sort();

    Ok(paths)
}

pub(crate) fn is_folder(path: &Path) -> Result<bool, StoreError> {
    fs::metadata(path)
        .map(|metadata| metadata.is_dir())
        .map_err(|source| io_error("check", path, source))
}

pub(crate) fn exists(path: &Path) -> Result<bool, StoreError> {
    path.try_exists()
        .map_err(|source| io_error("check", path, source))
}

pub(crate) fn io_error(action: &'static str, path: &Path, source: io::Error) -> StoreError {
    StoreError::Io {
        action,
        path: path.to_path_buf(),
        source,
    }
}

fn read_project(
    folder: &Path,
    project: &ProjectName,
    scan: &mut TicketScan,
) -> Result<(), StoreError> {
    for path in sorted_entries(folder)? {
        let is_ticket_file = path.extension().is_some_and(|extension| extension == "md");

        if !is_ticket_file || is_folder(&path)? {
            continue;
        }

        match read_ticket(&path, project)? {
            Ok(ticket) => scan.tickets.push(ticket),
            Err(unreadable) => scan.errors.push(unreadable),
        }
    }

    Ok(())
}

fn read_ticket(
    path: &Path,
    project: &ProjectName,
) -> Result<Result<StoredTicket, UnreadableTicket>, StoreError> {
    let file_name = path.file_name().unwrap_or_default().to_string_lossy();
    let id = TicketId::from_file_name(project, &file_name);
    let unreadable = |message: String| UnreadableTicket {
        path: path.to_path_buf(),
        id: id.clone(),
        message,
    };
    let Some(ticket_id) = id.clone() else {
        return Ok(Err(unreadable(format!(
            "the file name does not start with an ID of the project {project}"
        ))));
    };
    let bytes = fs::read(path).map_err(|source| io_error("read", path, source))?;
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return Ok(Err(unreadable("the file is not UTF-8".to_owned())));
    };

    Ok(TicketDocument::parse(text)
        .map(|document| StoredTicket {
            id: ticket_id,
            path: path.to_path_buf(),
            hash: sha256_hex(&bytes),
            text: text.to_owned(),
            document,
        })
        .map_err(|error| unreadable(error.to_string())))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{read_tickets, sha256_hex};

    #[test]
    fn a_store_without_a_tickets_folder_has_no_tickets() {
        let directory = tempfile::tempdir().expect("create a temporary directory");

        let scan = read_tickets(directory.path()).expect("the scan runs");

        assert!(scan.tickets.is_empty());
        assert!(scan.errors.is_empty());
    }

    #[test]
    fn read_tickets_lists_broken_files_and_reads_the_rest() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let project = directory.path().join("tickets/personal");
        fs::create_dir_all(project.join("personal-abcd")).expect("create a ticket folder");
        fs::create_dir_all(directory.path().join("tickets/Bad_Name")).expect("create a folder");
        let good = "---\nkind: task\ntitle: Good\nstatus: open\n---\nBody\n";
        fs::write(project.join("personal-abcd-good.md"), good).expect("write a ticket");
        fs::write(
            project.join("personal-wxyz-broken.md"),
            "---\nkind: [\n---\n",
        )
        .expect("write a broken ticket");
        fs::write(project.join("notes.md"), "notes").expect("write a stray file");
        fs::write(project.join("personal-abcd").join("design.md"), "design")
            .expect("write a folder file");
        fs::write(project.join("todo.txt"), "not a ticket").expect("write a text file");

        let scan = read_tickets(directory.path()).expect("the scan runs");

        assert_eq!(scan.tickets.len(), 1);
        assert_eq!(scan.tickets[0].id.to_string(), "personal-abcd");
        assert_eq!(scan.tickets[0].hash, sha256_hex(good.as_bytes()));
        assert_eq!(scan.tickets[0].document.body, "Body\n");
        let errors: Vec<_> = scan
            .errors
            .iter()
            .map(|error| {
                (
                    error
                        .path
                        .strip_prefix(directory.path())
                        .expect("inside the store")
                        .to_owned(),
                    error.id.as_ref().map(ToString::to_string),
                )
            })
            .collect();
        assert_eq!(
            errors,
            vec![
                ("tickets/Bad_Name".into(), None),
                ("tickets/personal/notes.md".into(), None),
                (
                    "tickets/personal/personal-wxyz-broken.md".into(),
                    Some("personal-wxyz".to_owned())
                ),
            ]
        );
    }

    #[test]
    fn sha256_hex_matches_a_known_digest() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
