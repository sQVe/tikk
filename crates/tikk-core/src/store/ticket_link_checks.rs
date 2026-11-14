use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;

use crate::store::StoreError;
use crate::store::ticket_files::TicketScan;
use crate::store::ticket_queries::ticket_path;
use crate::ticket::{Kind, TicketFields, TicketId};

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
    check_links_with(fields, scan, None)
}

// The scan holds the ticket as it was, so the ticket's new kind and parent replace its old ones.
pub(crate) fn check_written_links(
    id: &TicketId,
    fields: &TicketFields,
    scan: &TicketScan,
) -> Result<(), StoreError> {
    refuse_cycle(id, fields, scan)?;
    check_links_with(fields, scan, Some(id))?;

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
    scan: &TicketScan,
    written: Option<&TicketId>,
) -> Result<(), StoreError> {
    for id in fields.linked_ids() {
        if let Err(error @ StoreError::IdShared { .. }) = ticket_path(scan, id) {
            return Err(error);
        }
    }

    let mut kinds: HashMap<&TicketId, Kind> = scan
        .tickets
        .iter()
        .map(|ticket| (&ticket.id, ticket.document.fields.kind()))
        .collect();

    if let Some(id) = written {
        kinds.insert(id, fields.kind());
    }

    fields.check_links(|id| kinds.get(id).copied())?;

    Ok(())
}

fn refuse_cycle(id: &TicketId, fields: &TicketFields, scan: &TicketScan) -> Result<(), StoreError> {
    let waits: HashMap<&TicketId, &TicketFields> = scan
        .tickets
        .iter()
        .map(|ticket| (&ticket.id, &ticket.document.fields))
        .collect();

    for (field, link, target) in wait_edges(fields) {
        if let Some(path) = find_wait_path(target, id, &waits, scan)? {
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
    waits: &HashMap<&'a TicketId, &'a TicketFields>,
    scan: &TicketScan,
) -> Result<Option<Vec<WaitStep>>, StoreError> {
    let mut reached_from: HashMap<&TicketId, (&TicketId, WaitLink)> = HashMap::new();
    let mut queue = VecDeque::from([start]);
    let mut seen = HashSet::from([start]);

    while let Some(ticket) = queue.pop_front() {
        if ticket == goal {
            return Ok(Some(walk_back(start, goal, &reached_from)));
        }

        if let Err(error @ StoreError::IdShared { .. }) = ticket_path(scan, ticket) {
            return Err(error);
        }

        let edges = waits
            .get(ticket)
            .into_iter()
            .flat_map(|fields| wait_edges(fields));

        for (_, link, next) in edges {
            if seen.insert(next) {
                reached_from.insert(next, (ticket, link));
                queue.push_back(next);
            }
        }
    }

    Ok(None)
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

    use super::{WaitLink, WaitStep, check_written_links};
    use crate::store::StoreError;
    use crate::store::ticket_files::{StoredTicket, TicketScan};
    use crate::ticket::{TicketDocument, TicketFields, TicketId};

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
