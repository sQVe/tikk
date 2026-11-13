use std::fs;
use std::path::Path;

use crate::store::store_lock::{self, LockAccess, StoreLock};
use crate::store::ticket_files::{
    StoredTicket, TICKETS_FOLDER, TicketScan, UnreadableTicket, exists, io_error, read_tickets,
    sorted_entries,
};
use crate::store::{Store, StoreError};
use crate::ticket::{Kind, ProjectName, Status, TicketId};

#[derive(Clone, Copy)]
pub struct QueryEffects {
    pub lock_store: fn(&Path, LockAccess) -> Result<StoreLock, StoreError>,
}

impl QueryEffects {
    pub fn system() -> Self {
        Self {
            lock_store: store_lock::lock_store,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct TicketFilter {
    pub project: Option<ProjectName>,
    pub kind: Option<Kind>,
    pub parent: Option<TicketId>,
    pub status: Option<Status>,
    pub search: Option<String>,
}

#[derive(Debug)]
pub struct TicketListing {
    pub tickets: Vec<StoredTicket>,
    pub errors: Vec<UnreadableTicket>,
}

#[derive(Debug)]
pub struct ShownTicket {
    pub ticket: StoredTicket,
    pub children: Vec<StoredTicket>,
    pub files: Vec<String>,
}

/// Lists the tickets that match the filter, ranked ones first, then by ID. Every file that
/// fails to parse is in `errors`, whatever the filter.
pub fn list_tickets(
    store: &Store,
    filter: &TicketFilter,
    effects: &QueryEffects,
) -> Result<TicketListing, StoreError> {
    let scan = {
        let _lock = (effects.lock_store)(store.root(), LockAccess::Shared)?;

        read_tickets(store.root())?
    };
    let search = filter.search.as_deref().map(str::to_lowercase);
    let mut tickets: Vec<StoredTicket> = scan
        .tickets
        .into_iter()
        .filter(|ticket| filter.matches(ticket, search.as_deref()))
        .collect();

    sort_tickets(&mut tickets);

    Ok(TicketListing {
        tickets,
        errors: scan.errors,
    })
}

pub fn show_ticket(
    store: &Store,
    id: &TicketId,
    effects: &QueryEffects,
) -> Result<ShownTicket, StoreError> {
    let folder = store
        .root()
        .join(TICKETS_FOLDER)
        .join(id.project().as_str())
        .join(id.to_string());
    let _lock = (effects.lock_store)(store.root(), LockAccess::Shared)?;
    let scan = read_tickets(store.root())?;
    let ticket = find_ticket(&scan, id)?.clone();
    let mut children: Vec<StoredTicket> = scan
        .tickets
        .into_iter()
        .filter(|child| child.id != *id && child.document.fields.parent() == Some(id))
        .collect();

    sort_tickets(&mut children);

    Ok(ShownTicket {
        ticket,
        children,
        files: folder_files(&folder)?,
    })
}

pub(crate) fn find_ticket<'a>(
    scan: &'a TicketScan,
    id: &TicketId,
) -> Result<&'a StoredTicket, StoreError> {
    ticket_path(scan, id)?;

    if let Some(error) = scan
        .errors
        .iter()
        .find(|error| error.id.as_ref() == Some(id))
    {
        return Err(StoreError::TicketParse {
            path: error.path.clone(),
            message: error.message.clone(),
        });
    }

    scan.tickets
        .iter()
        .find(|ticket| ticket.id == *id)
        .ok_or_else(|| StoreError::NotFound { id: id.to_string() })
}

pub(crate) fn ticket_path<'a>(scan: &'a TicketScan, id: &TicketId) -> Result<&'a Path, StoreError> {
    let parsed = scan
        .tickets
        .iter()
        .filter(|ticket| ticket.id == *id)
        .map(|ticket| ticket.path.as_path());
    let broken = scan
        .errors
        .iter()
        .filter(|error| error.id.as_ref() == Some(id))
        .map(|error| error.path.as_path());
    let paths: Vec<&Path> = parsed.chain(broken).collect();

    match paths.as_slice() {
        [] => Err(StoreError::NotFound { id: id.to_string() }),
        [path] => Ok(path),
        _ => Err(StoreError::IdShared {
            id: id.to_string(),
            paths: paths.iter().map(|path| path.to_path_buf()).collect(),
        }),
    }
}

impl TicketFilter {
    fn matches(&self, ticket: &StoredTicket, search: Option<&str>) -> bool {
        let fields = &ticket.document.fields;
        let in_project = self
            .project
            .as_ref()
            .is_none_or(|project| ticket.id.project() == project);
        let of_kind = self.kind.is_none_or(|kind| fields.kind() == kind);
        let under_parent = self
            .parent
            .as_ref()
            .is_none_or(|parent| fields.parent() == Some(parent));
        let has_status = self.status.is_none_or(|status| fields.status() == status);
        let has_text = search.is_none_or(|text| {
            fields.title().to_lowercase().contains(text)
                || ticket.document.body.to_lowercase().contains(text)
        });

        in_project && of_kind && under_parent && has_status && has_text
    }
}

fn sort_tickets(tickets: &mut [StoredTicket]) {
    tickets.sort_by(|left, right| {
        let left_rank = left.document.fields.rank();
        let right_rank = right.document.fields.rank();

        (left_rank.is_none(), left_rank, &left.id).cmp(&(
            right_rank.is_none(),
            right_rank,
            &right.id,
        ))
    });
}

fn folder_files(folder: &Path) -> Result<Vec<String>, StoreError> {
    let mut files = Vec::new();

    if exists(folder)? {
        collect_files(folder, "", &mut files)?;
    }

    files.sort();

    Ok(files)
}

fn collect_files(folder: &Path, prefix: &str, files: &mut Vec<String>) -> Result<(), StoreError> {
    for path in sorted_entries(folder)? {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        let relative = format!("{prefix}{name}");

        if is_real_folder(&path)? {
            collect_files(&path, &format!("{relative}/"), files)?;
        } else {
            files.push(relative);
        }
    }

    Ok(())
}

fn is_real_folder(path: &Path) -> Result<bool, StoreError> {
    // A symlink counts as a file, so a link to an ancestor or an outside folder is never walked.
    fs::symlink_metadata(path)
        .map(|metadata| metadata.is_dir())
        .map_err(|source| io_error("check", path, source))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use std::path::{Path, PathBuf};

    use super::{QueryEffects, TicketFilter, list_tickets, show_ticket};
    use crate::store::store_lock::{LockAccess, StoreLock};
    use crate::store::{Store, StoreError};
    use crate::ticket::{Kind, ProjectName, Status, TicketId};

    const TICKETS: &[(&str, &str)] = &[
        (
            "personal/personal-3333-plan.md",
            "---\nkind: plan\ntitle: Move to tikk\n---\n",
        ),
        (
            "personal/personal-4444-lease.md",
            "---\nkind: task\ntitle: Decide the lease length\nparent: personal-3333\nrank: 2\n---\n",
        ),
        (
            "personal/personal-6666-import.md",
            "---\nkind: task\ntitle: Write the import note\nparent: personal-3333\nrank: 1\n---\nThe LOCK file moves.\n",
        ),
        (
            "personal/personal-7777-windows.md",
            "---\nkind: task\ntitle: Ask about Windows\nparent: personal-3333\nstatus: canceled\nreason: Linux and macOS only\n---\n",
        ),
        (
            "tikk/tikk-8888-lock.md",
            "---\nkind: task\ntitle: Lock the store\n---\n",
        ),
    ];

    fn store_with_tickets() -> (tempfile::TempDir, Store) {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        fs::create_dir(directory.path().join(".git")).expect("create the Git folder");

        for (path, text) in TICKETS {
            let path = directory.path().join("tickets").join(path);
            fs::create_dir_all(path.parent().expect("a parent folder")).expect("create a folder");
            fs::write(path, text).expect("write a ticket");
        }

        let store = Store {
            root: directory.path().to_path_buf(),
        };

        (directory, store)
    }

    fn id(text: &str) -> TicketId {
        TicketId::parse(text).expect("a valid ID")
    }

    fn listed(store: &Store, filter: &TicketFilter) -> Vec<String> {
        list_tickets(store, filter, &QueryEffects::system())
            .expect("the listing runs")
            .tickets
            .iter()
            .map(|ticket| ticket.id.to_string())
            .collect()
    }

    #[test]
    fn list_tickets_applies_each_filter() {
        let (_directory, store) = store_with_tickets();
        let cases = [
            (
                "no filter",
                TicketFilter::default(),
                vec![
                    "personal-6666",
                    "personal-4444",
                    "personal-3333",
                    "personal-7777",
                    "tikk-8888",
                ],
            ),
            (
                "project",
                TicketFilter {
                    project: Some(ProjectName::parse("tikk").expect("a valid name")),
                    ..TicketFilter::default()
                },
                vec!["tikk-8888"],
            ),
            (
                "kind",
                TicketFilter {
                    kind: Some(Kind::Plan),
                    ..TicketFilter::default()
                },
                vec!["personal-3333"],
            ),
            (
                "parent",
                TicketFilter {
                    parent: Some(id("personal-3333")),
                    ..TicketFilter::default()
                },
                vec!["personal-6666", "personal-4444", "personal-7777"],
            ),
            (
                "status",
                TicketFilter {
                    status: Some(Status::Canceled),
                    ..TicketFilter::default()
                },
                vec!["personal-7777"],
            ),
            (
                "search in title and body",
                TicketFilter {
                    search: Some("lock".to_owned()),
                    ..TicketFilter::default()
                },
                vec!["personal-6666", "tikk-8888"],
            ),
            (
                "search and kind",
                TicketFilter {
                    search: Some("LEASE".to_owned()),
                    kind: Some(Kind::Task),
                    ..TicketFilter::default()
                },
                vec!["personal-4444"],
            ),
        ];

        for (name, filter, expected) in cases {
            assert_eq!(listed(&store, &filter), expected, "case {name}");
        }
    }

    fn busy_lock(_: &Path, access: LockAccess) -> Result<StoreLock, StoreError> {
        Err(StoreError::Locked {
            lock: PathBuf::from(format!("{access:?}")),
        })
    }

    #[test]
    fn list_and_show_wait_for_the_shared_lock() {
        let (_directory, store) = store_with_tickets();
        let effects = QueryEffects {
            lock_store: busy_lock,
        };

        let listed = list_tickets(&store, &TicketFilter::default(), &effects);
        let shown = show_ticket(&store, &id("personal-3333"), &effects);

        let shared = PathBuf::from("Shared");
        assert!(
            matches!(&listed, Err(StoreError::Locked { lock }) if *lock == shared),
            "{listed:?}"
        );
        assert!(
            matches!(&shown, Err(StoreError::Locked { lock }) if *lock == shared),
            "{shown:?}"
        );
    }

    #[test]
    fn show_ticket_returns_the_ticket_and_its_children_in_rank_order() {
        let (_directory, store) = store_with_tickets();

        let shown = show_ticket(&store, &id("personal-3333"), &QueryEffects::system())
            .expect("the plan exists");

        assert_eq!(shown.ticket.document.fields.title(), "Move to tikk");
        let children: Vec<String> = shown
            .children
            .iter()
            .map(|child| child.id.to_string())
            .collect();
        assert_eq!(
            children,
            ["personal-6666", "personal-4444", "personal-7777"]
        );
        assert!(shown.files.is_empty());
    }

    #[test]
    fn show_ticket_reports_a_missing_a_broken_and_a_shared_id() {
        let (directory, store) = store_with_tickets();
        let project = directory.path().join("tickets/personal");
        fs::write(project.join("personal-9999-broken.md"), "kind: task\n").expect("write");
        fs::write(
            project.join("personal-4444-copy.md"),
            "---\nkind: task\ntitle: Copy\n---\n",
        )
        .expect("write");

        let missing = show_ticket(&store, &id("personal-wxyz"), &QueryEffects::system())
            .expect_err("no such ticket");
        let broken = show_ticket(&store, &id("personal-9999"), &QueryEffects::system())
            .expect_err("the file is broken");
        let shared = show_ticket(&store, &id("personal-4444"), &QueryEffects::system())
            .expect_err("two files share it");

        assert!(
            matches!(&missing, StoreError::NotFound { id } if id == "personal-wxyz"),
            "{missing:?}"
        );
        assert!(
            matches!(&broken, StoreError::TicketParse { path, .. } if path.ends_with("personal-9999-broken.md")),
            "{broken:?}"
        );
        assert!(
            matches!(&shared, StoreError::IdShared { paths, .. } if paths.len() == 2),
            "{shared:?}"
        );
    }

    #[test]
    fn show_ticket_lists_the_folder_files_with_relative_paths() {
        let (directory, store) = store_with_tickets();
        let folder = directory.path().join("tickets/personal/personal-3333");
        fs::create_dir_all(folder.join("reports")).expect("create the folder");
        fs::write(folder.join("design.md"), "").expect("write");
        fs::write(folder.join("reports/audit.md"), "").expect("write");

        let shown = show_ticket(&store, &id("personal-3333"), &QueryEffects::system())
            .expect("the plan exists");

        assert_eq!(shown.files, ["design.md", "reports/audit.md"]);
    }
}
