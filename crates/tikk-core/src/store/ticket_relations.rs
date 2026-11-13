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

/// Removes the edge even when the blocker no longer exists. The blocker is looked up only when
/// there is no edge. The links the ticket keeps are not checked, so a ticket with a broken link
/// can be repaired.
pub fn unblock_ticket(
    store: &Store,
    id: &TicketId,
    blocker: &TicketId,
    effects: &WriteEffects,
) -> Result<StoredTicket, StoreError> {
    change_ticket(store, id, effects, |fields, scan| {
        if !fields.blocked_by().contains(blocker) {
            find_ticket(scan, blocker)?;

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

    use tempfile::TempDir;

    use super::{block_ticket, move_ticket, unblock_ticket};
    use crate::store::store_lock::{LockAccess, StoreLock};
    use crate::store::ticket_file_write::replace_ticket_file;
    use crate::store::ticket_write::WriteEffects;
    use crate::store::{Store, StoreError};
    use crate::ticket::TicketId;

    const TASK: &str =
        "---\nkind: task\ntitle: Renew the domain\nblockedBy: [personal-bbbb]\n---\n";

    thread_local! {
        static LOCKED_WITH: Cell<Option<LockAccess>> = const { Cell::new(None) };
        static WRITES: Cell<usize> = const { Cell::new(0) };
    }

    const RANKED: &str = "---\nkind: task\ntitle: A\nparent: personal-pppp\nrank: 4\nblockedBy: [personal-bbbb, personal-cccc]\n---\n";

    fn count_write(path: &Path, text: &str, hash: &str) -> Result<(), StoreError> {
        WRITES.with(|writes| writes.set(writes.get() + 1));

        replace_ticket_file(path, text, hash)
    }

    fn counting_effects() -> WriteEffects {
        WriteEffects {
            replace_file: count_write,
            ..WriteEffects::system()
        }
    }

    fn store_with_ranked_task() -> (TempDir, Store, PathBuf) {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let folder = directory.path().join("tickets/personal");
        let path = folder.join("personal-aaaa-a.md");
        fs::create_dir_all(directory.path().join(".git")).expect("create the Git folder");
        fs::create_dir_all(&folder).expect("create the project folder");
        fs::write(&path, RANKED).expect("write the task");

        for (name, text) in [
            ("personal-pppp-p.md", "---\nkind: plan\ntitle: P\n---\n"),
            ("personal-qqqq-q.md", "---\nkind: plan\ntitle: Q\n---\n"),
            ("personal-bbbb-b.md", "---\nkind: task\ntitle: B\n---\n"),
            ("personal-cccc-c.md", "---\nkind: task\ntitle: C\n---\n"),
            ("personal-dddd-d.md", "---\nkind: task\ntitle: D\n---\n"),
        ] {
            fs::write(folder.join(name), text).expect("write a ticket");
        }

        let store = Store {
            root: directory.path().to_path_buf(),
        };

        (directory, store, path)
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

    #[test]
    fn an_edge_that_exists_a_missing_edge_and_the_same_parent_write_nothing() {
        let (_directory, store, path) = store_with_ranked_task();
        let task = id("personal-aaaa");
        let effects = counting_effects();

        let results = [
            (
                "block B again",
                block_ticket(&store, &task, &id("personal-bbbb"), &effects),
            ),
            (
                "unblock D",
                unblock_ticket(&store, &task, &id("personal-dddd"), &effects),
            ),
            (
                "move under P",
                move_ticket(&store, &task, Some(&id("personal-pppp")), &effects),
            ),
        ];

        for (name, result) in results {
            let ticket = result.unwrap_or_else(|error| panic!("case {name}: {error:?}"));

            assert_eq!(ticket.text, RANKED, "case {name}");
        }
        assert_eq!(WRITES.with(Cell::get), 0);
        assert_eq!(fs::read_to_string(&path).expect("read the task"), RANKED);
    }

    #[test]
    fn unblock_removes_only_the_named_blocker() {
        let (_directory, store, _path) = store_with_ranked_task();

        let unblocked = unblock_ticket(
            &store,
            &id("personal-aaaa"),
            &id("personal-bbbb"),
            &counting_effects(),
        )
        .expect("B blocks A");

        assert_eq!(
            unblocked.document.fields.blocked_by(),
            [id("personal-cccc")]
        );
        assert_eq!(unblocked.document.fields.rank(), Some(4));
    }

    #[test]
    fn unblock_of_a_missing_blocker_removes_its_edge_or_reports_it_not_found() {
        let (directory, store, path) = store_with_ranked_task();
        fs::remove_file(directory.path().join("tickets/personal/personal-cccc-c.md"))
            .expect("delete the blocker C");
        let task = id("personal-aaaa");

        let absent = unblock_ticket(&store, &task, &id("personal-zzzz"), &counting_effects());

        assert!(
            matches!(&absent, Err(StoreError::NotFound { id }) if id == "personal-zzzz"),
            "{absent:?}"
        );
        assert_eq!(WRITES.with(Cell::get), 0);
        assert_eq!(fs::read_to_string(&path).expect("read the task"), RANKED);

        let removed = unblock_ticket(&store, &task, &id("personal-cccc"), &counting_effects())
            .expect("an edge to a deleted blocker can be removed");

        assert_eq!(removed.document.fields.blocked_by(), [id("personal-bbbb")]);
        assert_eq!(
            fs::read_to_string(&path).expect("read the task"),
            removed.text
        );
    }

    #[test]
    fn move_to_a_new_parent_clears_the_rank() {
        let (_directory, store, path) = store_with_ranked_task();

        let moved = move_ticket(
            &store,
            &id("personal-aaaa"),
            Some(&id("personal-qqqq")),
            &counting_effects(),
        )
        .expect("a task can sit under another plan");

        assert_eq!(moved.document.fields.parent(), Some(&id("personal-qqqq")));
        assert_eq!(moved.document.fields.rank(), None);
        assert_eq!(
            fs::read_to_string(&path).expect("read the task"),
            moved.text
        );
    }
}
