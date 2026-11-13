use crate::store::store_lock::LockAccess;
use crate::store::ticket_files::{StoredTicket, TicketScan, read_tickets};
use crate::store::ticket_queries::{find_ticket, list_order};
use crate::store::ticket_write::{WriteEffects, replace_ticket};
use crate::store::{Store, StoreError};
use crate::ticket::{TicketDocument, TicketId};

/// Where `rank_ticket` puts a ticket among its siblings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RankPlace {
    First,
    Last,
    Before(TicketId),
    After(TicketId),
}

/// Ranks the siblings 1..n in the new order and writes only the files whose rank changed. Each
/// file write is atomic, but the set is not: a failed write leaves the earlier siblings renumbered,
/// which is still a valid order.
pub fn rank_ticket(
    store: &Store,
    id: &TicketId,
    place: &RankPlace,
    effects: &WriteEffects,
) -> Result<StoredTicket, StoreError> {
    let _lock = (effects.lock_store)(store.root(), LockAccess::Exclusive)?;
    let scan = read_tickets(store.root())?;
    let current = find_ticket(&scan, id)?;
    let mut order = sorted_siblings(&scan, current);
    let from = order
        .iter()
        .position(|sibling| sibling.id == *id)
        .expect("a ticket is its own sibling");

    order.remove(from);

    let to = place_index(&scan, current, &order, place, from)?;

    order.insert(to, current);

    let mut ranked = current.clone();

    for (rank, sibling) in (1_i64..).zip(order) {
        if sibling.document.fields.rank() == Some(rank) {
            continue;
        }

        let document = TicketDocument {
            fields: sibling.document.fields.with_rank(Some(rank)),
            body: sibling.document.body.clone(),
        };
        let written = replace_ticket(sibling, document, effects)?;

        if written.id == *id {
            ranked = written;
        }
    }

    Ok(ranked)
}

fn sorted_siblings<'a>(scan: &'a TicketScan, ticket: &StoredTicket) -> Vec<&'a StoredTicket> {
    let parent = ticket.document.fields.parent();
    let mut siblings: Vec<&StoredTicket> = scan
        .tickets
        .iter()
        .filter(|other| {
            other.document.fields.parent() == parent && other.id.project() == ticket.id.project()
        })
        .collect();

    siblings.sort_by(|left, right| list_order(left, right));

    siblings
}

// `others` holds the siblings without the ranked ticket, which sat at `from`.
fn place_index(
    scan: &TicketScan,
    ticket: &StoredTicket,
    others: &[&StoredTicket],
    place: &RankPlace,
    from: usize,
) -> Result<usize, StoreError> {
    let (anchor, offset) = match place {
        RankPlace::First => return Ok(0),
        RankPlace::Last => return Ok(others.len()),
        RankPlace::Before(anchor) => (anchor, 0),
        RankPlace::After(anchor) => (anchor, 1),
    };

    find_ticket(scan, anchor)?;

    if *anchor == ticket.id {
        return Ok(from);
    }

    others
        .iter()
        .position(|sibling| sibling.id == *anchor)
        .map(|index| index + offset)
        .ok_or_else(|| StoreError::NotSibling {
            id: ticket.id.to_string(),
            anchor: anchor.to_string(),
        })
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs;
    use std::path::{Path, PathBuf};

    use tempfile::TempDir;

    use super::{RankPlace, rank_ticket};
    use crate::store::store_lock::{LockAccess, StoreLock};
    use crate::store::ticket_file_write::replace_ticket_file;
    use crate::store::ticket_write::WriteEffects;
    use crate::store::{Store, StoreError};
    use crate::ticket::TicketId;

    thread_local! {
        static WRITES: Cell<usize> = const { Cell::new(0) };
        static LOCKED_WITH: Cell<Option<LockAccess>> = const { Cell::new(None) };
    }

    fn busy_lock(_: &Path, access: LockAccess) -> Result<StoreLock, StoreError> {
        LOCKED_WITH.with(|locked| locked.set(Some(access)));

        Err(StoreError::Locked {
            lock: PathBuf::from("tikk.lock"),
        })
    }

    // Writes the first file, then fails the way a full disk would.
    fn fail_after_one_write(path: &Path, text: &str, hash: &str) -> Result<(), StoreError> {
        let writes = WRITES.with(|writes| writes.replace(writes.get() + 1));

        if writes == 0 {
            return replace_ticket_file(path, text, hash);
        }

        Err(StoreError::Io {
            action: "write",
            path: path.to_path_buf(),
            source: std::io::Error::other("disk full"),
        })
    }

    fn store_with(files: &[(&str, &str)]) -> (TempDir, Store) {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let folder = directory.path().join("tickets/personal");
        fs::create_dir_all(directory.path().join(".git")).expect("create the Git folder");
        fs::create_dir_all(&folder).expect("create the project folder");

        for (name, text) in files {
            fs::write(folder.join(name), text).expect("write a ticket");
        }

        let store = Store {
            root: directory.path().to_path_buf(),
        };

        (directory, store)
    }

    fn rank_of(directory: &TempDir, name: &str) -> Option<String> {
        let path: PathBuf = directory.path().join("tickets/personal").join(name);
        let text = fs::read_to_string(path).expect("read a ticket");

        text.lines()
            .find_map(|line| line.strip_prefix("rank: "))
            .map(str::to_owned)
    }

    #[test]
    fn a_failed_write_part_way_reports_the_error_and_keeps_a_valid_order() {
        let (directory, store) = store_with(&[
            ("personal-aaaa-a.md", "---\nkind: task\ntitle: A\n---\n"),
            ("personal-bbbb-b.md", "---\nkind: task\ntitle: B\n---\n"),
            ("personal-cccc-c.md", "---\nkind: task\ntitle: C\n---\n"),
        ]);
        let effects = WriteEffects {
            replace_file: fail_after_one_write,
            ..WriteEffects::system()
        };

        let result = rank_ticket(
            &store,
            &TicketId::parse("personal-cccc").expect("a valid ID"),
            &RankPlace::First,
            &effects,
        );

        assert!(
            matches!(
                &result,
                Err(StoreError::Io {
                    action: "write",
                    ..
                })
            ),
            "{result:?}"
        );
        assert_eq!(
            rank_of(&directory, "personal-cccc-c.md").as_deref(),
            Some("1")
        );
        assert_eq!(rank_of(&directory, "personal-aaaa-a.md"), None);
        assert_eq!(rank_of(&directory, "personal-bbbb-b.md"), None);
    }

    #[test]
    fn a_held_lock_stops_rank_before_it_writes() {
        let (directory, store) =
            store_with(&[("personal-aaaa-a.md", "---\nkind: task\ntitle: A\n---\n")]);
        let effects = WriteEffects {
            lock_store: busy_lock,
            ..WriteEffects::system()
        };

        let result = rank_ticket(
            &store,
            &TicketId::parse("personal-aaaa").expect("a valid ID"),
            &RankPlace::First,
            &effects,
        );

        assert!(
            matches!(result, Err(StoreError::Locked { .. })),
            "{result:?}"
        );
        assert_eq!(LOCKED_WITH.with(Cell::get), Some(LockAccess::Exclusive));
        assert_eq!(rank_of(&directory, "personal-aaaa-a.md"), None);
    }
}
