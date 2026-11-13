use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;

use crate::store::StoreError;
use crate::store::ticket_files::TicketScan;
use crate::store::ticket_index::{TicketIndex, TicketLookup, shared};
use crate::ticket::{TicketFields, TicketId};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitLink {
    BlockedBy,
    Parent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WaitStep {
    pub waiter: TicketId,
    pub link: WaitLink,
    pub target: TicketId,
}

impl fmt::Display for WaitStep {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.link {
            WaitLink::BlockedBy => {
                write!(formatter, "{} is blocked by {}", self.waiter, self.target)
            }
            WaitLink::Parent => write!(formatter, "{} has the parent {}", self.waiter, self.target),
        }
    }
}

pub(crate) fn check_ticket_links(
    fields: &TicketFields,
    scan: &TicketScan,
) -> Result<(), StoreError> {
    check_links_with(fields, &TicketIndex::new(scan), None)
}

// The scan holds the ticket as it was, so the ticket's new kind and parent replace its old ones.
pub(crate) fn check_written_links(
    id: &TicketId,
    fields: &TicketFields,
    scan: &TicketScan,
) -> Result<(), StoreError> {
    let index = TicketIndex::new(scan);

    refuse_cycle(id, fields, &index)?;
    check_links_with(fields, &index, Some(id))?;

    let children = scan
        .tickets
        .iter()
        .filter(|ticket| ticket.id != *id && ticket.document.fields.parent() == Some(id));

    for child in children {
        fields.check_child(&child.id, child.document.fields.kind())?;
    }

    Ok(())
}

fn check_links_with(
    fields: &TicketFields,
    index: &TicketIndex<'_>,
    written: Option<&TicketId>,
) -> Result<(), StoreError> {
    for id in fields.linked_ids() {
        refuse_shared(index, id)?;
    }

    fields.check_links(|id| {
        if written == Some(id) {
            return Some(fields.kind());
        }

        found_fields(index, id).map(TicketFields::kind)
    })?;

    Ok(())
}

fn refuse_cycle(
    id: &TicketId,
    fields: &TicketFields,
    index: &TicketIndex<'_>,
) -> Result<(), StoreError> {
    for (field, link, target) in wait_edges(fields) {
        if let Some(path) = find_wait_path(target, id, index)? {
            let mut steps = vec![WaitStep {
                waiter: id.clone(),
                link,
                target: target.clone(),
            }];

            steps.extend(path);

            return Err(StoreError::Cycle { field, steps });
        }
    }

    Ok(())
}

fn wait_edges(fields: &TicketFields) -> impl Iterator<Item = (&'static str, WaitLink, &TicketId)> {
    let parent = fields
        .parent()
        .map(|parent| ("parent", WaitLink::Parent, parent));
    let blockers = fields
        .blocked_by()
        .iter()
        .map(|blocker| ("blockedBy", WaitLink::BlockedBy, blocker));

    parent.into_iter().chain(blockers)
}

// A shared ID is refused, because the walk cannot know which file's links to follow.
fn find_wait_path<'a>(
    start: &'a TicketId,
    goal: &TicketId,
    index: &TicketIndex<'a>,
) -> Result<Option<Vec<WaitStep>>, StoreError> {
    let mut reached_from: HashMap<&TicketId, (&TicketId, WaitLink)> = HashMap::new();
    let mut queue = VecDeque::from([start]);
    let mut seen = HashSet::from([start]);

    while let Some(ticket) = queue.pop_front() {
        if ticket == goal {
            return Ok(Some(walk_back(start, goal, &reached_from)));
        }

        refuse_shared(index, ticket)?;

        let edges = found_fields(index, ticket).into_iter().flat_map(wait_edges);

        for (_, link, next) in edges {
            if seen.insert(next) {
                reached_from.insert(next, (ticket, link));
                queue.push_back(next);
            }
        }
    }

    Ok(None)
}

fn refuse_shared(index: &TicketIndex<'_>, id: &TicketId) -> Result<(), StoreError> {
    match index.look_up(id) {
        TicketLookup::Shared(paths) => Err(shared(id, &paths)),
        _ => Ok(()),
    }
}

fn found_fields<'a>(index: &TicketIndex<'a>, id: &TicketId) -> Option<&'a TicketFields> {
    match index.look_up(id) {
        TicketLookup::Found(ticket) => Some(&ticket.document.fields),
        _ => None,
    }
}

fn walk_back(
    start: &TicketId,
    goal: &TicketId,
    reached_from: &HashMap<&TicketId, (&TicketId, WaitLink)>,
) -> Vec<WaitStep> {
    let mut steps = Vec::new();
    let mut target = goal;

    while target != start {
        let (waiter, link) = reached_from[target];

        steps.push(WaitStep {
            waiter: waiter.clone(),
            link,
            target: target.clone(),
        });
        target = waiter;
    }

    steps.reverse();

    steps
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{WaitLink, WaitStep, check_ticket_links, check_written_links};
    use crate::store::StoreError;
    use crate::store::ticket_files::{StoredTicket, TicketScan, UnreadableTicket};
    use crate::ticket::{TicketDocument, TicketError, TicketFields, TicketId};

    fn id(text: &str) -> TicketId {
        TicketId::parse(text).expect("a valid ID")
    }

    fn scan(tickets: &[(&str, &str)]) -> TicketScan {
        let tickets = tickets
            .iter()
            .map(|(ticket, text)| StoredTicket {
                id: id(ticket),
                path: PathBuf::from(format!("{ticket}.md")),
                hash: String::new(),
                text: (*text).to_owned(),
                document: TicketDocument::parse(text).expect("the ticket parses"),
            })
            .collect();

        TicketScan {
            tickets,
            errors: Vec::new(),
        }
    }

    fn fields(text: &str) -> TicketFields {
        TicketDocument::parse(text)
            .expect("the document parses")
            .fields
    }

    fn step(waiter: &str, link: WaitLink, target: &str) -> WaitStep {
        WaitStep {
            waiter: id(waiter),
            link,
            target: id(target),
        }
    }

    #[test]
    fn a_link_to_an_unreadable_ticket_names_no_ticket() {
        let mut store = scan(&[("personal-aaaa", "---\nkind: task\ntitle: A\n---\n")]);
        store.errors.push(UnreadableTicket {
            path: PathBuf::from("personal-bbbb.md"),
            id: Some(id("personal-bbbb")),
            message: "the document does not parse".to_owned(),
        });
        let linked =
            fields("---\nkind: task\ntitle: N\nrelated: [personal-aaaa, personal-bbbb]\n---\n");

        let error =
            check_ticket_links(&linked, &store).expect_err("the second link names no ticket");

        assert!(
            matches!(&error, StoreError::Ticket(TicketError::Invalid { field, problem })
                if field == "related" && problem == "names personal-bbbb, but no ticket has that ID"),
            "{error:?}"
        );
    }

    #[test]
    fn a_link_to_an_id_that_two_files_hold_is_refused_as_shared() {
        let store = scan(&[
            ("personal-pppp", "---\nkind: plan\ntitle: P\n---\n"),
            ("personal-pppp", "---\nkind: plan\ntitle: P again\n---\n"),
        ]);
        let linked = fields("---\nkind: task\ntitle: N\nparent: personal-pppp\n---\n");

        let error = check_ticket_links(&linked, &store).expect_err("the parent ID is shared");

        assert!(
            matches!(&error, StoreError::IdShared { id, paths } if id == "personal-pppp" && paths.len() == 2),
            "{error:?}"
        );
    }

    #[test]
    fn a_parent_of_a_kind_that_cannot_hold_the_ticket_is_refused() {
        let store = scan(&[("personal-aaaa", "---\nkind: task\ntitle: A\n---\n")]);
        let linked = fields("---\nkind: slice\ntitle: N\nparent: personal-aaaa\n---\n");

        let error =
            check_ticket_links(&linked, &store).expect_err("a slice cannot sit under a task");

        assert!(
            matches!(&error, StoreError::Ticket(TicketError::Invalid { field, .. }) if field == "parent"),
            "{error:?}"
        );
    }

    #[test]
    fn a_cycle_lists_the_shortest_walk_back_to_the_changed_ticket() {
        let store = scan(&[
            ("personal-pppp", "---\nkind: plan\ntitle: P\n---\n"),
            (
                "personal-aaaa",
                "---\nkind: task\ntitle: A\nparent: personal-pppp\nblockedBy: [personal-cccc]\n---\n",
            ),
            (
                "personal-bbbb",
                "---\nkind: task\ntitle: B\nblockedBy: [personal-aaaa, personal-pppp]\n---\n",
            ),
            ("personal-cccc", "---\nkind: task\ntitle: C\n---\n"),
        ]);
        let changed = fields("---\nkind: plan\ntitle: P\nblockedBy: [personal-bbbb]\n---\n");

        let error = check_written_links(&id("personal-pppp"), &changed, &store)
            .expect_err("the plan would wait on itself");

        assert!(
            matches!(&error, StoreError::Cycle { field: "blockedBy", steps } if *steps == [
                step("personal-pppp", WaitLink::BlockedBy, "personal-bbbb"),
                step("personal-bbbb", WaitLink::BlockedBy, "personal-pppp"),
            ]),
            "{error:?}"
        );
        assert_eq!(
            error.to_string(),
            "`blockedBy` would make a cycle: personal-pppp is blocked by personal-bbbb, \
             personal-bbbb is blocked by personal-pppp."
        );
    }

    #[test]
    fn a_ticket_that_blocks_itself_is_a_cycle_of_one() {
        let store = scan(&[("personal-aaaa", "---\nkind: task\ntitle: A\n---\n")]);
        let changed = fields("---\nkind: task\ntitle: A\nblockedBy: [personal-aaaa]\n---\n");

        let error = check_written_links(&id("personal-aaaa"), &changed, &store)
            .expect_err("the task would wait on itself");

        assert!(
            matches!(&error, StoreError::Cycle { field: "blockedBy", steps } if *steps == [
                step("personal-aaaa", WaitLink::BlockedBy, "personal-aaaa"),
            ]),
            "{error:?}"
        );
    }

    #[test]
    fn a_walk_that_never_reaches_the_changed_ticket_passes() {
        let store = scan(&[
            ("personal-aaaa", "---\nkind: task\ntitle: A\n---\n"),
            (
                "personal-bbbb",
                "---\nkind: task\ntitle: B\nblockedBy: [personal-cccc]\n---\n",
            ),
            (
                "personal-cccc",
                "---\nkind: task\ntitle: C\nblockedBy: [personal-bbbb]\n---\n",
            ),
        ]);
        let changed = fields("---\nkind: task\ntitle: A\nblockedBy: [personal-bbbb]\n---\n");

        let checked = check_written_links(&id("personal-aaaa"), &changed, &store);

        assert!(checked.is_ok(), "{checked:?}");
    }

    #[test]
    fn a_walk_through_an_id_that_two_files_hold_is_refused_as_shared() {
        // The first C waits on A and the second has no edges, so picking one file could hide the cycle.
        let store = scan(&[
            ("personal-aaaa", "---\nkind: task\ntitle: A\n---\n"),
            (
                "personal-bbbb",
                "---\nkind: task\ntitle: B\nblockedBy: [personal-cccc]\n---\n",
            ),
            (
                "personal-cccc",
                "---\nkind: task\ntitle: C\nblockedBy: [personal-aaaa]\n---\n",
            ),
            ("personal-cccc", "---\nkind: task\ntitle: C again\n---\n"),
        ]);
        let changed = fields("---\nkind: task\ntitle: A\nblockedBy: [personal-bbbb]\n---\n");

        let error = check_written_links(&id("personal-aaaa"), &changed, &store)
            .expect_err("the walk reaches a shared ID");

        assert!(
            matches!(&error, StoreError::IdShared { id, paths } if id == "personal-cccc" && paths.len() == 2),
            "{error:?}"
        );
    }
}
