use crate::store::ticket_files::StoredTicket;
use crate::store::ticket_link_checks::check_written_links;
use crate::store::ticket_queries::find_ticket;
use crate::store::ticket_write::{WriteEffects, change_ticket, refuse_other_project};
use crate::store::{Store, StoreError};
use crate::ticket::TicketId;

pub fn block_ticket(
    store: &Store,
    id: &TicketId,
    blocker: &TicketId,
    effects: &WriteEffects,
) -> Result<StoredTicket, StoreError> {
    change_ticket(store, id, effects, |fields, scan| {
        find_ticket(scan, blocker)?;

        if fields.blocked_by().contains(blocker) {
            return Ok(None);
        }

        let mut blockers = fields.blocked_by().to_vec();

        blockers.push(blocker.clone());

        let changed = fields.with_blocked_by(blockers);

        check_written_links(id, &changed, scan)?;

        Ok(Some(changed))
    })
}

// A blocker that no longer exists can still be removed, so the blocker is not looked up.
pub fn unblock_ticket(
    store: &Store,
    id: &TicketId,
    blocker: &TicketId,
    effects: &WriteEffects,
) -> Result<StoredTicket, StoreError> {
    change_ticket(store, id, effects, |fields, _scan| {
        if !fields.blocked_by().contains(blocker) {
            return Ok(None);
        }

        let blockers = fields
            .blocked_by()
            .iter()
            .filter(|kept| *kept != blocker)
            .cloned()
            .collect();

        Ok(Some(fields.with_blocked_by(blockers)))
    })
}

/// Moves the ticket under `parent`, or makes it loose when `parent` is `None`. The old rank ordered
/// the old siblings, so a move clears it.
pub fn move_ticket(
    store: &Store,
    id: &TicketId,
    parent: Option<&TicketId>,
    effects: &WriteEffects,
) -> Result<StoredTicket, StoreError> {
    change_ticket(store, id, effects, |fields, scan| {
        if fields.parent() == parent {
            return Ok(None);
        }

        let changed = fields.with_parent(parent.cloned())?.with_rank(None);

        refuse_other_project(id, &changed)?;
        check_written_links(id, &changed, scan)?;

        Ok(Some(changed))
    })
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs;
    use std::path::{Path, PathBuf};

    use super::{block_ticket, move_ticket, unblock_ticket};
    use crate::store::store_lock::{LockAccess, StoreLock};
    use crate::store::ticket_write::WriteEffects;
    use crate::store::{Store, StoreError};
    use crate::ticket::TicketId;

    const TASK: &str =
        "---\nkind: task\ntitle: Renew the domain\nblockedBy: [personal-bbbb]\n---\n";

    thread_local! {
        static LOCKED_WITH: Cell<Option<LockAccess>> = const { Cell::new(None) };
    }

    fn busy_lock(_: &Path, access: LockAccess) -> Result<StoreLock, StoreError> {
        LOCKED_WITH.with(|locked| locked.set(Some(access)));

        Err(StoreError::Locked {
            lock: PathBuf::from("tikk.lock"),
        })
    }

    fn id(text: &str) -> TicketId {
        TicketId::parse(text).expect("a valid ID")
    }

    #[test]
    fn a_held_lock_stops_block_unblock_and_move_before_they_write() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let folder = directory.path().join("tickets/personal");
        let path = folder.join("personal-aaaa-renew.md");
        fs::create_dir_all(&folder).expect("create the project folder");
        fs::write(&path, TASK).expect("write the task");
        fs::write(
            folder.join("personal-bbbb-pay.md"),
            "---\nkind: task\ntitle: Pay\n---\n",
        )
        .expect("write the blocker");
        let store = Store {
            root: directory.path().to_path_buf(),
        };
        let effects = WriteEffects {
            lock_store: busy_lock,
            ..WriteEffects::system()
        };
        let task = id("personal-aaaa");
        let blocker = id("personal-bbbb");

        let results = [
            ("block", block_ticket(&store, &task, &blocker, &effects)),
            ("unblock", unblock_ticket(&store, &task, &blocker, &effects)),
            ("move", move_ticket(&store, &task, None, &effects)),
        ];

        for (name, result) in results {
            assert!(
                matches!(result, Err(StoreError::Locked { .. })),
                "case {name}: {result:?}"
            );
        }
        assert_eq!(LOCKED_WITH.with(Cell::get), Some(LockAccess::Exclusive));
        assert_eq!(fs::read_to_string(&path).expect("read the task"), TASK);
    }
}
