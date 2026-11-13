use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use crate::fact::{Claim, PrState, ShownPr};
use crate::store::derived_state::{DerivedStates, DerivedStatus};
use crate::store::ticket_files::StoredTicket;
use crate::store::ticket_index::{TicketIndex, TicketLookup};
use crate::ticket::{Kind, Status, TicketId};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Hold {
    Draft,
    MergedUnverified,
    BlockedBy {
        blocker: TicketId,
        via: Option<TicketId>,
        state: BlockerState,
    },
    Parent {
        parent: TicketId,
        state: BlockerState,
    },
    Claimed(Claim),
    IdShared {
        paths: Vec<PathBuf>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockerState {
    Open,
    Draft,
    Canceled,
    MergedUnverified,
    Missing,
    Unreadable,
    Shared,
}

impl BlockerState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Draft => "draft",
            Self::Canceled => "canceled",
            Self::MergedUnverified => "mergedUnverified",
            Self::Missing => "missing",
            Self::Unreadable => "unreadable",
            Self::Shared => "shared",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StackParent {
    pub slice: TicketId,
    pub pr: ShownPr,
}

enum BlockerEdge {
    Holds(Hold),
    Stacks(StackParent),
    Cleared,
}

pub(crate) fn blocking_holds(
    slice: &StoredTicket,
    lookups: &TicketIndex<'_>,
    prs: &HashMap<TicketId, ShownPr>,
    derived: &DerivedStates,
) -> (Vec<Hold>, Option<StackParent>) {
    let (mut holds, edges) = own_holds_and_edges(slice, lookups);
    let mut stack_parents = Vec::new();

    for (blocker, via) in edges {
        match classify_edge(blocker, via, lookups, prs, derived) {
            BlockerEdge::Holds(hold) => holds.push(hold),
            BlockerEdge::Stacks(parent) => stack_parents.push(parent),
            BlockerEdge::Cleared => {}
        }
    }

    let stack_parent = stack_parents
        .into_iter()
        .min_by(|left, right| left.slice.cmp(&right.slice));

    (holds, stack_parent)
}

// Returns the draft and plan holds, and each blocker edge once, the slice's own edges first.
fn own_holds_and_edges<'a>(
    slice: &'a StoredTicket,
    lookups: &TicketIndex<'a>,
) -> (Vec<Hold>, Vec<(&'a TicketId, Option<&'a TicketId>)>) {
    let fields = &slice.document.fields;
    let mut holds = Vec::new();
    let mut named: Vec<(&TicketId, Option<&TicketId>)> = fields
        .blocked_by()
        .iter()
        .map(|blocker| (blocker, None))
        .collect();

    if fields.status() == Status::Draft {
        holds.push(Hold::Draft);
    }

    if let Some(parent) = fields.parent() {
        match found(lookups.look_up(parent)) {
            Ok(plan) => {
                let plan_fields = &plan.document.fields;

                if let Some(state) = plan_hold(plan_fields.status()) {
                    holds.push(Hold::Parent {
                        parent: parent.clone(),
                        state,
                    });
                }

                named.extend(
                    plan_fields
                        .blocked_by()
                        .iter()
                        .map(|blocker| (blocker, Some(parent))),
                );
            }
            Err(state) => holds.push(Hold::Parent {
                parent: parent.clone(),
                state,
            }),
        }
    }

    let mut seen = HashSet::new();

    named.retain(|(blocker, _)| seen.insert(*blocker));

    (holds, named)
}

fn classify_edge(
    blocker: &TicketId,
    via: Option<&TicketId>,
    lookups: &TicketIndex<'_>,
    prs: &HashMap<TicketId, ShownPr>,
    derived: &DerivedStates,
) -> BlockerEdge {
    let lookup = lookups.look_up(blocker);

    if via.is_none()
        && let Some(pr) = open_slice_pr(&lookup, prs)
    {
        return BlockerEdge::Stacks(StackParent {
            slice: blocker.clone(),
            pr: pr.clone(),
        });
    }

    match blocker_state(lookup, derived) {
        Some(state) => BlockerEdge::Holds(Hold::BlockedBy {
            blocker: blocker.clone(),
            via: via.cloned(),
            state,
        }),
        None => BlockerEdge::Cleared,
    }
}

fn open_slice_pr<'a>(
    lookup: &TicketLookup<'_>,
    prs: &'a HashMap<TicketId, ShownPr>,
) -> Option<&'a ShownPr> {
    let TicketLookup::Found(ticket) = lookup else {
        return None;
    };

    if ticket.document.fields.kind() != Kind::Slice {
        return None;
    }

    prs.get(&ticket.id)
        .filter(|shown| shown.state() == PrState::Open)
}

fn plan_hold(status: Status) -> Option<BlockerState> {
    match status {
        Status::Draft => Some(BlockerState::Draft),
        Status::Canceled => Some(BlockerState::Canceled),
        Status::Open | Status::Done => None,
    }
}

fn blocker_state(lookup: TicketLookup<'_>, derived: &DerivedStates) -> Option<BlockerState> {
    match found(lookup) {
        Ok(ticket) => match derived.effective(ticket) {
            DerivedStatus::Done | DerivedStatus::Canceled => None,
            DerivedStatus::Open | DerivedStatus::AuditBehind => Some(BlockerState::Open),
            DerivedStatus::MergedUnverified => Some(BlockerState::MergedUnverified),
            DerivedStatus::Draft => Some(BlockerState::Draft),
        },
        Err(state) => Some(state),
    }
}

fn found(lookup: TicketLookup<'_>) -> Result<&StoredTicket, BlockerState> {
    match lookup {
        TicketLookup::Found(ticket) => Ok(ticket),
        TicketLookup::Unreadable(_) => Err(BlockerState::Unreadable),
        TicketLookup::Shared(_) => Err(BlockerState::Shared),
        TicketLookup::Missing => Err(BlockerState::Missing),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::PathBuf;

    use super::{BlockerState, Hold, StackParent, blocking_holds};
    use crate::fact::{
        FactEvent, FactLine, PrObservation, PrState, PullRequest, ShownPr, Timestamp, current_prs,
    };
    use crate::store::derived_state::{DerivedStates, derive_states};
    use crate::store::fact_files::FactScan;
    use crate::store::ticket_files::{StoredTicket, TicketScan};
    use crate::store::ticket_index::TicketIndex;
    use crate::ticket::{TicketDocument, TicketId};

    const CRITERIA: &str = "criteria:\n  - id: s1\n    check: c\n    expected: e\n";

    struct Tickets {
        scan: TicketScan,
        prs: HashMap<TicketId, ShownPr>,
        derived: DerivedStates,
    }

    impl Tickets {
        fn new(tickets: Vec<StoredTicket>, pr_lines: &[(&str, u64, PrState)]) -> Self {
            let scan = TicketScan {
                tickets,
                errors: Vec::new(),
            };
            let facts = FactScan {
                facts: pr_lines
                    .iter()
                    .map(|(slice, number, state)| pr(slice, *number, *state))
                    .collect(),
                errors: Vec::new(),
            };
            let prs = current_prs(&facts.facts);
            let derived = derive_states(&scan, &facts, &prs);

            Self { scan, prs, derived }
        }

        fn holds_of(&self, slice: &str) -> (Vec<Hold>, Option<StackParent>) {
            let index = TicketIndex::new(&self.scan);
            let slice = self
                .scan
                .tickets
                .iter()
                .find(|ticket| ticket.id == id(slice))
                .expect("the slice is in the scan");

            blocking_holds(slice, &index, &self.prs, &self.derived)
        }
    }

    fn id(text: &str) -> TicketId {
        TicketId::parse(text).expect("a valid ID")
    }

    fn ticket(name: &str, front: &str) -> StoredTicket {
        let text = format!("---\n{front}---\n");

        StoredTicket {
            id: id(name),
            path: PathBuf::from(format!("{name}.md")),
            hash: "hash".to_owned(),
            document: TicketDocument::parse(&text).expect("a valid ticket"),
            text,
        }
    }

    fn reason(status: &str) -> &'static str {
        if status == "canceled" {
            "reason: Dropped\n"
        } else {
            ""
        }
    }

    fn plan(name: &str, status: &str, blocked_by: &str) -> StoredTicket {
        ticket(
            name,
            &format!(
                "kind: plan\ntitle: Plan\nstatus: {status}\n{}blockedBy: [{blocked_by}]\n",
                reason(status)
            ),
        )
    }

    fn slice(name: &str, parent: &str, blocked_by: &str) -> StoredTicket {
        ticket(
            name,
            &format!(
                "kind: slice\ntitle: Slice\nparent: {parent}\nblockedBy: [{blocked_by}]\n{CRITERIA}"
            ),
        )
    }

    fn task(name: &str, status: &str, blocked_by: &str) -> StoredTicket {
        ticket(
            name,
            &format!(
                "kind: task\ntitle: Task\nstatus: {status}\n{}blockedBy: [{blocked_by}]\n",
                reason(status)
            ),
        )
    }

    fn pr(slice: &str, number: u64, state: PrState) -> FactLine {
        FactLine {
            ticket: id(slice),
            at: Timestamp::parse("2026-11-13T01:00:00Z").expect("a valid time"),
            event: FactEvent::Pr(PrObservation {
                pull_request: PullRequest::new("owner/app", number).expect("a valid PR"),
                state,
                base: "main".to_owned(),
                head: format!("head-{number}"),
                merge_commit: None,
                in_trunk: false,
            }),
        }
    }

    fn blocked(blocker: &str, via: Option<&str>, state: BlockerState) -> Hold {
        Hold::BlockedBy {
            blocker: id(blocker),
            via: via.map(id),
            state,
        }
    }

    #[test]
    fn a_slice_blocked_only_by_slices_with_open_prs_stacks_on_the_smallest_blocker() {
        let tickets = Tickets::new(
            vec![
                plan("personal-pppp", "open", ""),
                slice("personal-xxxx", "personal-pppp", ""),
                slice("personal-yyyy", "personal-pppp", ""),
                slice(
                    "personal-kkkk",
                    "personal-pppp",
                    "personal-yyyy, personal-xxxx",
                ),
            ],
            &[
                ("personal-xxxx", 7, PrState::Open),
                ("personal-yyyy", 8, PrState::Open),
            ],
        );

        let (holds, stack_parent) = tickets.holds_of("personal-kkkk");

        assert_eq!(holds, []);
        let parent = stack_parent.expect("it has a stack parent");
        assert_eq!(parent.slice, id("personal-xxxx"));
        assert_eq!(parent.pr.observation.pull_request.number(), 7);
        assert_eq!(parent.pr.state(), PrState::Open);
        assert_eq!(
            parent.pr.checked_at,
            Timestamp::parse("2026-11-13T01:00:00Z").expect("a valid time")
        );
        assert_eq!(tickets.holds_of("personal-xxxx"), (Vec::new(), None));
    }

    #[test]
    fn only_a_slices_own_blocker_slice_with_an_open_pr_clears() {
        let tickets = Tickets::new(
            vec![
                plan("personal-pppp", "open", "personal-qqqq"),
                slice("personal-qqqq", "personal-pppp", ""),
                slice("personal-mmmm", "personal-pppp", ""),
                slice("personal-cccc", "personal-pppp", ""),
                slice("personal-nnnn", "personal-pppp", ""),
                task("personal-tttt", "open", "personal-qqqq"),
                slice(
                    "personal-kkkk",
                    "personal-pppp",
                    "personal-mmmm, personal-cccc, personal-nnnn, personal-tttt",
                ),
            ],
            &[
                ("personal-qqqq", 1, PrState::Open),
                ("personal-mmmm", 2, PrState::Merged),
                ("personal-cccc", 3, PrState::Closed),
                ("personal-tttt", 4, PrState::Open),
            ],
        );

        let (holds, stack_parent) = tickets.holds_of("personal-kkkk");

        assert_eq!(
            holds,
            vec![
                blocked("personal-mmmm", None, BlockerState::Open),
                blocked("personal-cccc", None, BlockerState::Open),
                blocked("personal-nnnn", None, BlockerState::Open),
                blocked("personal-tttt", None, BlockerState::Open),
                blocked("personal-qqqq", Some("personal-pppp"), BlockerState::Open),
            ]
        );
        assert_eq!(stack_parent, None);
    }

    #[test]
    fn each_blocker_state_has_its_contract_name() {
        let names = [
            BlockerState::Open,
            BlockerState::Draft,
            BlockerState::Canceled,
            BlockerState::Missing,
            BlockerState::Unreadable,
            BlockerState::Shared,
        ]
        .map(BlockerState::as_str);

        assert_eq!(
            names,
            [
                "open",
                "draft",
                "canceled",
                "missing",
                "unreadable",
                "shared"
            ]
        );
    }

    #[test]
    fn a_slice_is_held_once_by_each_open_blocker_of_its_own_and_of_its_plan() {
        let tickets = Tickets::new(
            vec![
                plan("personal-pppp", "open", "personal-xxxx, personal-yyyy"),
                slice(
                    "personal-kkkk",
                    "personal-pppp",
                    "personal-xxxx, personal-zzzz, personal-mmmm, personal-rrrr",
                ),
                task("personal-xxxx", "open", ""),
                task("personal-yyyy", "open", ""),
                task("personal-zzzz", "done", ""),
                task("personal-rrrr", "canceled", ""),
            ],
            &[],
        );

        let (holds, _) = tickets.holds_of("personal-kkkk");

        assert_eq!(
            holds,
            vec![
                blocked("personal-xxxx", None, BlockerState::Open),
                blocked("personal-mmmm", None, BlockerState::Missing),
                blocked("personal-yyyy", Some("personal-pppp"), BlockerState::Open),
            ]
        );
    }

    #[test]
    fn a_slice_is_held_by_a_draft_or_canceled_plan_and_not_by_an_open_one() {
        let tickets = Tickets::new(
            vec![
                plan("personal-dddd", "draft", ""),
                plan("personal-cccc", "canceled", ""),
                plan("personal-nnnn", "open", ""),
                slice("personal-aaaa", "personal-dddd", ""),
                slice("personal-bbbb", "personal-cccc", ""),
                slice("personal-eeee", "personal-nnnn", ""),
            ],
            &[],
        );
        let cases = [
            ("personal-dddd", "personal-aaaa", Some(BlockerState::Draft)),
            (
                "personal-cccc",
                "personal-bbbb",
                Some(BlockerState::Canceled),
            ),
            ("personal-nnnn", "personal-eeee", None),
        ];

        for (plan, slice, state) in cases {
            let expected: Vec<Hold> = state
                .map(|state| Hold::Parent {
                    parent: id(plan),
                    state,
                })
                .into_iter()
                .collect();

            let (holds, _) = tickets.holds_of(slice);

            assert_eq!(holds, expected, "case {plan}");
        }
    }
}
