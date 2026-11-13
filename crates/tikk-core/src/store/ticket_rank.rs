use crate::store::store_lock::LockAccess;
use crate::store::ticket_files::{StoredTicket, TicketScan, read_tickets};
use crate::store::ticket_queries::{find_ticket, list_order};
use crate::store::ticket_write::{WriteEffects, replace_ticket};
use crate::store::{Store, StoreError};
use crate::ticket::{TicketDocument, TicketId};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RankPlace {
    First,
    Last,
    Before(TicketId),
    After(TicketId),
}

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
    use std::cell::{Cell, RefCell};
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
        static WRITTEN: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    }

    fn record_write(path: &Path, text: &str, hash: &str) -> Result<(), StoreError> {
        let name = path
            .file_name()
            .expect("a ticket path has a file name")
            .to_string_lossy()
            .into_owned();

        WRITTEN.with(|written| written.borrow_mut().push(name));

        replace_ticket_file(path, text, hash)
    }

    fn recording_effects() -> WriteEffects {
        WRITTEN.with(|written| written.borrow_mut().clear());

        WriteEffects {
            replace_file: record_write,
            ..WriteEffects::system()
        }
    }

    fn written_files() -> Vec<String> {
        let mut names = WRITTEN.with(|written| written.borrow().clone());

        names.sort();

        names
    }

    const PLAN: &str = "---\nkind: plan\ntitle: P\n---\n";

    fn task(title: &str, rank: i64) -> String {
        format!("---\nkind: task\ntitle: {title}\nparent: personal-pppp\nrank: {rank}\n---\n")
    }

    fn ranked_siblings() -> (TempDir, Store) {
        let (a, b, c) = (task("A", 1), task("B", 2), task("C", 3));

        store_with(&[
            ("personal-pppp-p.md", PLAN),
            ("personal-aaaa-a.md", &a),
            ("personal-bbbb-b.md", &b),
            ("personal-cccc-c.md", &c),
        ])
    }

    fn id(text: &str) -> TicketId {
        TicketId::parse(text).expect("a valid ID")
    }

    fn sibling_ranks(directory: &TempDir) -> Vec<Option<String>> {
        [
            "personal-aaaa-a.md",
            "personal-bbbb-b.md",
            "personal-cccc-c.md",
        ]
        .iter()
        .map(|name| rank_of(directory, name))
        .collect()
    }

    fn busy_lock(_: &Path, access: LockAccess) -> Result<StoreLock, StoreError> {
        LOCKED_WITH.with(|locked| locked.set(Some(access)));

        Err(StoreError::Locked {
            lock: PathBuf::from("tikk.lock"),
        })
    }

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

    #[test]
    fn rank_places_the_ticket_and_writes_only_the_files_whose_rank_changed() {
        let a = "personal-aaaa-a.md";
        let b = "personal-bbbb-b.md";
        let c = "personal-cccc-c.md";
        let cases = [
            (
                "C first",
                "personal-cccc",
                RankPlace::First,
                ["2", "3", "1"],
                1,
                vec![a, b, c],
            ),
            (
                "A last",
                "personal-aaaa",
                RankPlace::Last,
                ["3", "1", "2"],
                3,
                vec![a, b, c],
            ),
            (
                "A before C",
                "personal-aaaa",
                RankPlace::Before(id("personal-cccc")),
                ["2", "1", "3"],
                2,
                vec![a, b],
            ),
            (
                "C before A",
                "personal-cccc",
                RankPlace::Before(id("personal-aaaa")),
                ["2", "3", "1"],
                1,
                vec![a, b, c],
            ),
            (
                "C after A",
                "personal-cccc",
                RankPlace::After(id("personal-aaaa")),
                ["1", "3", "2"],
                2,
                vec![b, c],
            ),
            (
                "A after B",
                "personal-aaaa",
                RankPlace::After(id("personal-bbbb")),
                ["2", "1", "3"],
                2,
                vec![a, b],
            ),
            (
                "A after C",
                "personal-aaaa",
                RankPlace::After(id("personal-cccc")),
                ["3", "1", "2"],
                3,
                vec![a, b, c],
            ),
            (
                "B before itself",
                "personal-bbbb",
                RankPlace::Before(id("personal-bbbb")),
                ["1", "2", "3"],
                2,
                vec![],
            ),
            (
                "B after itself",
                "personal-bbbb",
                RankPlace::After(id("personal-bbbb")),
                ["1", "2", "3"],
                2,
                vec![],
            ),
            (
                "A first",
                "personal-aaaa",
                RankPlace::First,
                ["1", "2", "3"],
                1,
                vec![],
            ),
        ];

        for (name, ticket, place, ranks, rank, written) in cases {
            let (directory, store) = ranked_siblings();

            let ranked = rank_ticket(&store, &id(ticket), &place, &recording_effects())
                .unwrap_or_else(|error| panic!("case {name}: {error:?}"));

            assert_eq!(
                sibling_ranks(&directory),
                ranks.map(|rank| Some(rank.to_owned())),
                "case {name}"
            );
            assert_eq!(ranked.id, id(ticket), "case {name}");
            assert_eq!(ranked.document.fields.rank(), Some(rank), "case {name}");
            assert_eq!(written_files(), written, "case {name}");
        }
    }

    #[test]
    fn rank_refuses_an_anchor_with_another_parent_and_names_it() {
        let (directory, store) = ranked_siblings();
        let before = sibling_ranks(&directory);

        let result = rank_ticket(
            &store,
            &id("personal-aaaa"),
            &RankPlace::Before(id("personal-pppp")),
            &recording_effects(),
        );

        assert!(
            matches!(
                &result,
                Err(StoreError::NotSibling { id, anchor })
                    if id == "personal-aaaa" && anchor == "personal-pppp"
            ),
            "{result:?}"
        );
        assert_eq!(sibling_ranks(&directory), before);
        assert_eq!(written_files(), Vec::<String>::new());
    }

    #[test]
    fn rank_of_a_loose_ticket_orders_only_the_loose_tickets_of_its_project() {
        let (a, b, c) = (task("A", 1), task("B", 2), task("C", 3));
        let (directory, store) = store_with(&[
            ("personal-pppp-p.md", PLAN),
            ("personal-aaaa-a.md", &a),
            ("personal-bbbb-b.md", &b),
            ("personal-cccc-c.md", &c),
            ("personal-dddd-d.md", "---\nkind: task\ntitle: D\n---\n"),
        ]);
        let other = directory.path().join("tickets/tikk/tikk-eeee-e.md");
        let other_text = "---\nkind: task\ntitle: E\n---\n";
        fs::create_dir_all(other.parent().expect("a ticket has a folder"))
            .expect("create the other project folder");
        fs::write(&other, other_text).expect("write the other project's ticket");

        let ranked = rank_ticket(
            &store,
            &id("personal-dddd"),
            &RankPlace::Last,
            &recording_effects(),
        )
        .expect("a loose task can be ranked");

        assert_eq!(ranked.document.fields.rank(), Some(2));
        assert_eq!(
            rank_of(&directory, "personal-pppp-p.md").as_deref(),
            Some("1")
        );
        assert_eq!(
            written_files(),
            ["personal-dddd-d.md", "personal-pppp-p.md"]
        );

        let across = rank_ticket(
            &store,
            &id("personal-dddd"),
            &RankPlace::Before(id("tikk-eeee")),
            &recording_effects(),
        );

        assert!(
            matches!(&across, Err(StoreError::NotSibling { anchor, .. }) if anchor == "tikk-eeee"),
            "{across:?}"
        );
        assert_eq!(
            fs::read_to_string(&other).expect("read the other ticket"),
            other_text
        );
    }
}
