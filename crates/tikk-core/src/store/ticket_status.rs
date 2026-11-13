use crate::store::claim_lease::{instruction_slice, write_for_slice};
use crate::store::identity::Identity;
use crate::store::store_lock::LockAccess;
use crate::store::ticket_files::{StoredTicket, read_tickets};
use crate::store::ticket_queries::find_ticket;
use crate::store::ticket_write::{WriteEffects, change_scanned};
use crate::store::{Store, StoreError};
use crate::ticket::{Status, TicketFields, TicketId};

pub fn mark_done(
    store: &Store,
    id: &TicketId,
    caller: &Identity,
    effects: &WriteEffects,
) -> Result<StoredTicket, StoreError> {
    change_status(store, id, caller, effects, |fields| {
        let kind = fields.kind();

        if !kind.allows(Status::Done) {
            return Err(StoreError::WrongKind {
                id: id.to_string(),
                kind,
                allowed: "a task or an instruction",
            });
        }

        Ok(fields.with_status(Status::Done, None)?)
    })
}

pub fn cancel_ticket(
    store: &Store,
    id: &TicketId,
    reason: &str,
    caller: &Identity,
    effects: &WriteEffects,
) -> Result<StoredTicket, StoreError> {
    change_status(store, id, caller, effects, |fields| {
        Ok(fields.with_status(Status::Canceled, Some(reason))?)
    })
}

fn change_status(
    store: &Store,
    id: &TicketId,
    caller: &Identity,
    effects: &WriteEffects,
    change: impl FnOnce(&TicketFields) -> Result<TicketFields, StoreError>,
) -> Result<StoredTicket, StoreError> {
    let _lock = (effects.lock_store)(store.root(), LockAccess::Exclusive)?;
    let scan = read_tickets(store.root())?;
    let slice = instruction_slice(&find_ticket(&scan, id)?.document.fields);

    write_for_slice(store.root(), slice, caller, &effects.lease, || {
        change_scanned(&scan, id, effects, |fields, _scan| change(fields).map(Some))
    })
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs;
    use std::path::{Path, PathBuf};

    use tempfile::TempDir;

    use super::{cancel_ticket, mark_done};
    use crate::store::identity::Identity;
    use crate::store::store_lock::{LockAccess, StoreLock};
    use crate::store::ticket_write::WriteEffects;
    use crate::store::{Store, StoreError};
    use crate::ticket::{Kind, Status, TicketId};

    const PLAN: &str = "---\nkind: plan\ntitle: Move to tikk\n---\nThe design.\n";
    const TASK: &str = "---\nkind: task\ntitle: Renew the domain\n---\nBy May.\n";

    thread_local! {
        static LOCKED_WITH: Cell<Option<LockAccess>> = const { Cell::new(None) };
    }

    fn busy_lock(_: &Path, access: LockAccess) -> Result<StoreLock, StoreError> {
        LOCKED_WITH.with(|locked| locked.set(Some(access)));

        Err(StoreError::Locked {
            lock: PathBuf::from("tikk.lock"),
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

    fn id(text: &str) -> TicketId {
        TicketId::parse(text).expect("a valid ID")
    }

    #[test]
    fn mark_done_refuses_a_plan_and_names_its_kind() {
        let (directory, store) = store_with(&[("personal-abcd-plan.md", PLAN)]);

        let error = mark_done(
            &store,
            &id("personal-abcd"),
            &Identity::default(),
            &WriteEffects::system(),
        )
        .expect_err("a plan is never done by hand");

        assert!(
            matches!(&error, StoreError::WrongKind { id, kind: Kind::Plan, .. } if id == "personal-abcd"),
            "{error:?}"
        );
        let text = fs::read_to_string(
            directory
                .path()
                .join("tickets/personal/personal-abcd-plan.md"),
        )
        .expect("read the plan");
        assert_eq!(text, PLAN);
    }

    #[test]
    fn cancel_keeps_the_body_and_stores_the_reason() {
        let (_directory, store) = store_with(&[("personal-abcd-renew.md", TASK)]);

        let canceled = cancel_ticket(
            &store,
            &id("personal-abcd"),
            "Sold the domain",
            &Identity::default(),
            &WriteEffects::system(),
        )
        .expect("a task can be canceled");

        assert_eq!(canceled.document.fields.status(), Status::Canceled);
        assert_eq!(canceled.document.fields.reason(), Some("Sold the domain"));
        assert_eq!(canceled.document.body, "By May.\n");
        assert_eq!(
            fs::read_to_string(&canceled.path).expect("read the task"),
            canceled.text
        );
    }

    #[test]
    fn a_held_lock_stops_done_and_cancel_before_they_write() {
        let (directory, store) = store_with(&[("personal-abcd-renew.md", TASK)]);
        let effects = WriteEffects {
            lock_store: busy_lock,
            ..WriteEffects::system()
        };

        let person = Identity::default();

        let done = mark_done(&store, &id("personal-abcd"), &person, &effects);
        let canceled = cancel_ticket(&store, &id("personal-abcd"), "Gone", &person, &effects);

        for (name, result) in [("done", done), ("cancel", canceled)] {
            assert!(
                matches!(result, Err(StoreError::Locked { .. })),
                "case {name}: {result:?}"
            );
        }
        assert_eq!(LOCKED_WITH.with(Cell::get), Some(LockAccess::Exclusive));
        let text = fs::read_to_string(
            directory
                .path()
                .join("tickets/personal/personal-abcd-renew.md"),
        )
        .expect("read the task");
        assert_eq!(text, TASK);
    }
}
