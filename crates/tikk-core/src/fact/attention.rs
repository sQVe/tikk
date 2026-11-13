use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use crate::fact::{AgentName, Claim, ClaimState, Question, QuestionItem, ShownPr, Timestamp};
use crate::ticket::{Kind, TicketId};

/// A ticket whose ID is in exactly one file, with the state that the derivation gives it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttentionTicket {
    pub id: TicketId,
    pub kind: Kind,
    pub state: AttentionState,
    pub parent: Option<TicketId>,
    pub blocked_by: Vec<TicketId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttentionState {
    Open,
    /// A draft, or a slice whose audit is behind its PR head.
    Unfinished,
    MergedUnverified,
    /// Done or canceled.
    Finished,
}

pub struct AttentionInput<'a> {
    pub tickets: &'a [AttentionTicket],
    pub questions: &'a HashMap<TicketId, Vec<Question>>,
    pub claims: &'a HashMap<TicketId, Claim>,
    pub prs: &'a HashMap<TicketId, ShownPr>,
    pub problems: Vec<AttentionProblem>,
    pub now: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attention {
    pub items: Vec<AttentionItem>,
    pub problems: Vec<AttentionProblem>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttentionItem {
    pub id: TicketId,
    pub reason: AttentionReason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttentionReason {
    Question {
        item: QuestionItem,
        text: String,
    },
    StaleClaim {
        holder: AgentName,
        lease_end: Timestamp,
    },
    BlockingTask {
        blocks: Vec<TicketId>,
    },
    LooseTask,
    MergedUnverified {
        pr: ShownPr,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttentionProblem {
    TicketUnreadable {
        path: PathBuf,
        message: String,
    },
    IdShared {
        id: TicketId,
        paths: Vec<PathBuf>,
    },
    FactUnreadable {
        path: PathBuf,
        line: usize,
        message: String,
    },
    /// The last sync stopped with an error. `files` are the conflicting files, relative to the
    /// store.
    SyncFailed {
        at: Option<String>,
        message: String,
        files: Vec<String>,
    },
    /// The last sync finished and reported a problem with one of its steps.
    SyncProblem {
        at: Option<String>,
        step: String,
        message: String,
        files: Vec<String>,
    },
    SyncResultUnreadable {
        path: PathBuf,
        message: String,
    },
}

impl AttentionReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Question { .. } => "question",
            Self::StaleClaim { .. } => "staleClaim",
            Self::BlockingTask { .. } => "blockingTask",
            Self::LooseTask => "looseTask",
            Self::MergedUnverified { .. } => "mergedUnverified",
        }
    }

    fn order(&self) -> u8 {
        match self {
            Self::Question { .. } => 0,
            Self::StaleClaim { .. } => 1,
            Self::BlockingTask { .. } => 2,
            Self::LooseTask => 3,
            Self::MergedUnverified { .. } => 4,
        }
    }

    fn item(&self) -> Option<&QuestionItem> {
        match self {
            Self::Question { item, .. } => Some(item),
            _ => None,
        }
    }
}

impl AttentionProblem {
    pub fn code(&self) -> &'static str {
        match self {
            Self::TicketUnreadable { .. } => "parseError",
            Self::IdShared { .. } => "idShared",
            Self::FactUnreadable { .. } => "factUnreadable",
            Self::SyncFailed { .. } => "syncFailed",
            Self::SyncProblem { .. } => "syncProblem",
            Self::SyncResultUnreadable { .. } => "syncResultUnreadable",
        }
    }
}

/// Lists what waits on the user, ordered by reason, then by ticket ID, then by question item.
pub fn attention(input: AttentionInput<'_>) -> Attention {
    let tickets: HashMap<&TicketId, &AttentionTicket> = input
        .tickets
        .iter()
        .map(|ticket| (&ticket.id, ticket))
        .collect();
    let mut items = open_questions(input.questions);

    items.extend(stale_claims(input.claims, &tickets, input.now));
    items.extend(blocking_tasks(input.tickets, &tickets));
    items.extend(loose_tasks(input.tickets));
    items.extend(merged_unverified(input.tickets, input.prs));
    items.sort_by(|left, right| {
        let left_key = (left.reason.order(), &left.id, left.reason.item());
        let right_key = (right.reason.order(), &right.id, right.reason.item());

        left_key.cmp(&right_key)
    });

    Attention {
        items,
        problems: input.problems,
    }
}

fn open_questions(questions: &HashMap<TicketId, Vec<Question>>) -> Vec<AttentionItem> {
    questions
        .iter()
        .flat_map(|(id, asked)| {
            asked
                .iter()
                .filter(|question| question.is_open())
                .map(|question| AttentionItem {
                    id: id.clone(),
                    reason: AttentionReason::Question {
                        item: question.item.clone(),
                        text: question.text.clone(),
                    },
                })
        })
        .collect()
}

fn stale_claims(
    claims: &HashMap<TicketId, Claim>,
    tickets: &HashMap<&TicketId, &AttentionTicket>,
    now: Timestamp,
) -> Vec<AttentionItem> {
    claims
        .iter()
        .filter(|(id, claim)| {
            let finished = tickets
                .get(id)
                .is_some_and(|ticket| ticket.state == AttentionState::Finished);

            claim.state(now) == ClaimState::StaleClaim && !finished
        })
        .map(|(id, claim)| AttentionItem {
            id: id.clone(),
            reason: AttentionReason::StaleClaim {
                holder: claim.agent.clone(),
                lease_end: claim.lease_end,
            },
        })
        .collect()
}

fn blocking_tasks(
    all: &[AttentionTicket],
    tickets: &HashMap<&TicketId, &AttentionTicket>,
) -> Vec<AttentionItem> {
    let mut blocks: BTreeMap<&TicketId, Vec<TicketId>> = BTreeMap::new();

    for dependent in all {
        if dependent.state == AttentionState::Finished {
            continue;
        }

        for blocker in &dependent.blocked_by {
            if tickets
                .get(blocker)
                .is_some_and(|ticket| is_open_task(ticket))
            {
                blocks
                    .entry(blocker)
                    .or_default()
                    .push(dependent.id.clone());
            }
        }
    }

    blocks
        .into_iter()
        .map(|(task, mut dependents)| {
            dependents.sort();
            dependents.dedup();

            AttentionItem {
                id: task.clone(),
                reason: AttentionReason::BlockingTask { blocks: dependents },
            }
        })
        .collect()
}

fn loose_tasks(tickets: &[AttentionTicket]) -> Vec<AttentionItem> {
    tickets
        .iter()
        .filter(|ticket| is_open_task(ticket) && ticket.parent.is_none())
        .map(|ticket| AttentionItem {
            id: ticket.id.clone(),
            reason: AttentionReason::LooseTask,
        })
        .collect()
}

fn merged_unverified(
    tickets: &[AttentionTicket],
    prs: &HashMap<TicketId, ShownPr>,
) -> Vec<AttentionItem> {
    tickets
        .iter()
        .filter(|ticket| ticket.state == AttentionState::MergedUnverified)
        .filter_map(|ticket| {
            prs.get(&ticket.id).map(|pr| AttentionItem {
                id: ticket.id.clone(),
                reason: AttentionReason::MergedUnverified { pr: pr.clone() },
            })
        })
        .collect()
}

fn is_open_task(ticket: &AttentionTicket) -> bool {
    ticket.kind == Kind::Task && ticket.state == AttentionState::Open
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::PathBuf;

    use super::{
        AttentionInput, AttentionItem, AttentionProblem, AttentionReason, AttentionState,
        AttentionTicket, attention,
    };
    use crate::fact::{
        AgentName, Answer, Claim, PrObservation, PrState, PullRequest, Question, QuestionItem,
        ShownPr, Timestamp,
    };
    use crate::ticket::{Kind, TicketId};

    fn at(text: &str) -> Timestamp {
        Timestamp::parse(text).expect("a valid time")
    }

    fn id(text: &str) -> TicketId {
        TicketId::parse(text).expect("a valid ID")
    }

    fn ticket(name: &str, kind: Kind, state: AttentionState) -> AttentionTicket {
        AttentionTicket {
            id: id(name),
            kind,
            state,
            parent: Some(id("tikk-pppp")),
            blocked_by: Vec::new(),
        }
    }

    fn question(code: &str, answered: bool) -> Question {
        Question {
            item: QuestionItem::parse(code).expect("a valid item"),
            text: format!("Question {code}?"),
            asked_at: at("2026-11-13T01:00:00Z"),
            answer: answered.then(|| Answer {
                text: "yes".to_owned(),
                answered_at: at("2026-11-13T02:00:00Z"),
            }),
        }
    }

    fn claim(agent: &str, lease_end: &str) -> Claim {
        Claim {
            agent: AgentName::parse(agent).expect("a valid agent"),
            session: None,
            session_log: None,
            lease_end: at(lease_end),
        }
    }

    fn merged_pr() -> ShownPr {
        ShownPr {
            observation: PrObservation {
                pull_request: PullRequest::new("owner/app", 7).expect("a valid PR"),
                state: PrState::Merged,
                base: "main".to_owned(),
                head: "head".to_owned(),
                merge_commit: Some("merge".to_owned()),
                in_trunk: true,
            },
            checked_at: at("2026-11-13T03:00:00Z"),
        }
    }

    struct Fixture {
        tickets: Vec<AttentionTicket>,
        questions: HashMap<TicketId, Vec<Question>>,
        claims: HashMap<TicketId, Claim>,
        prs: HashMap<TicketId, ShownPr>,
    }

    impl Fixture {
        fn new(tickets: Vec<AttentionTicket>) -> Self {
            Self {
                tickets,
                questions: HashMap::new(),
                claims: HashMap::new(),
                prs: HashMap::new(),
            }
        }

        fn items(&self) -> Vec<(String, &'static str)> {
            attention(AttentionInput {
                tickets: &self.tickets,
                questions: &self.questions,
                claims: &self.claims,
                prs: &self.prs,
                problems: Vec::new(),
                now: at("2026-11-13T12:00:00Z"),
            })
            .items
            .iter()
            .map(|item| (item.id.to_string(), item.reason.as_str()))
            .collect()
        }
    }

    #[test]
    fn each_reason_has_its_contract_name_and_each_problem_its_code() {
        let reasons = [
            (AttentionReason::LooseTask, "looseTask"),
            (
                AttentionReason::BlockingTask { blocks: Vec::new() },
                "blockingTask",
            ),
        ];
        let problems = [
            (
                AttentionProblem::TicketUnreadable {
                    path: PathBuf::new(),
                    message: String::new(),
                },
                "parseError",
            ),
            (
                AttentionProblem::IdShared {
                    id: id("tikk-abcd"),
                    paths: Vec::new(),
                },
                "idShared",
            ),
            (
                AttentionProblem::FactUnreadable {
                    path: PathBuf::new(),
                    line: 1,
                    message: String::new(),
                },
                "factUnreadable",
            ),
            (
                AttentionProblem::SyncFailed {
                    at: None,
                    message: String::new(),
                    files: Vec::new(),
                },
                "syncFailed",
            ),
            (
                AttentionProblem::SyncProblem {
                    at: None,
                    step: "push".to_owned(),
                    message: String::new(),
                    files: Vec::new(),
                },
                "syncProblem",
            ),
            (
                AttentionProblem::SyncResultUnreadable {
                    path: PathBuf::new(),
                    message: String::new(),
                },
                "syncResultUnreadable",
            ),
        ];

        for (reason, expected) in reasons {
            assert_eq!(reason.as_str(), expected);
        }
        for (problem, expected) in problems {
            assert_eq!(problem.code(), expected);
        }
    }

    #[test]
    fn an_open_question_shows_on_a_ticket_of_any_state_until_it_is_answered() {
        let mut fixture = Fixture::new(vec![ticket(
            "tikk-dddd",
            Kind::Slice,
            AttentionState::Finished,
        )]);
        fixture.questions.insert(
            id("tikk-dddd"),
            vec![question("bbbb", false), question("aaaa", true)],
        );

        let listed = attention(AttentionInput {
            tickets: &fixture.tickets,
            questions: &fixture.questions,
            claims: &fixture.claims,
            prs: &fixture.prs,
            problems: Vec::new(),
            now: at("2026-11-13T12:00:00Z"),
        });

        assert_eq!(
            listed.items,
            [AttentionItem {
                id: id("tikk-dddd"),
                reason: AttentionReason::Question {
                    item: QuestionItem::parse("bbbb").expect("a valid item"),
                    text: "Question bbbb?".to_owned(),
                },
            }]
        );
    }

    #[test]
    fn a_stale_claim_shows_unless_the_ticket_is_finished_and_a_live_one_never() {
        let mut fixture = Fixture::new(vec![
            ticket("tikk-aaaa", Kind::Slice, AttentionState::Open),
            ticket("tikk-bbbb", Kind::Slice, AttentionState::Finished),
            ticket("tikk-cccc", Kind::Slice, AttentionState::Open),
        ]);
        fixture
            .claims
            .insert(id("tikk-aaaa"), claim("manager", "2026-11-13T12:00:00Z"));
        fixture
            .claims
            .insert(id("tikk-bbbb"), claim("manager", "2026-11-13T04:00:00Z"));
        fixture.claims.insert(
            id("tikk-cccc"),
            claim("manager", "2026-11-13T12:00:00.001Z"),
        );

        let listed = attention(AttentionInput {
            tickets: &fixture.tickets,
            questions: &fixture.questions,
            claims: &fixture.claims,
            prs: &fixture.prs,
            problems: Vec::new(),
            now: at("2026-11-13T12:00:00Z"),
        });

        assert_eq!(
            listed.items,
            [AttentionItem {
                id: id("tikk-aaaa"),
                reason: AttentionReason::StaleClaim {
                    holder: AgentName::parse("manager").expect("a valid agent"),
                    lease_end: at("2026-11-13T12:00:00Z"),
                },
            }]
        );
    }

    #[test]
    fn an_open_task_blocks_each_unfinished_ticket_that_lists_it() {
        let mut slice = ticket("tikk-kkkk", Kind::Slice, AttentionState::Unfinished);
        slice.blocked_by = vec![id("tikk-tttt"), id("tikk-dddd"), id("tikk-mmmm")];
        let mut plan = ticket("tikk-pppp", Kind::Plan, AttentionState::Open);
        plan.parent = None;
        plan.blocked_by = vec![id("tikk-tttt")];
        let mut finished = ticket("tikk-ffff", Kind::Slice, AttentionState::Finished);
        finished.blocked_by = vec![id("tikk-tttt"), id("tikk-wwww")];
        let fixture = Fixture::new(vec![
            slice,
            plan,
            finished,
            ticket("tikk-tttt", Kind::Task, AttentionState::Open),
            ticket("tikk-dddd", Kind::Task, AttentionState::Finished),
            ticket("tikk-mmmm", Kind::Slice, AttentionState::Open),
            ticket("tikk-wwww", Kind::Task, AttentionState::Open),
        ]);

        let listed = attention(AttentionInput {
            tickets: &fixture.tickets,
            questions: &fixture.questions,
            claims: &fixture.claims,
            prs: &fixture.prs,
            problems: Vec::new(),
            now: at("2026-11-13T12:00:00Z"),
        });

        assert_eq!(
            listed.items,
            [AttentionItem {
                id: id("tikk-tttt"),
                reason: AttentionReason::BlockingTask {
                    blocks: vec![id("tikk-kkkk"), id("tikk-pppp")],
                },
            }]
        );
    }

    #[test]
    fn only_an_open_task_with_no_parent_is_loose() {
        let loose = |name: &str, kind: Kind, state: AttentionState| AttentionTicket {
            parent: None,
            ..ticket(name, kind, state)
        };
        let fixture = Fixture::new(vec![
            loose("tikk-aaaa", Kind::Task, AttentionState::Open),
            loose("tikk-bbbb", Kind::Task, AttentionState::Finished),
            loose("tikk-cccc", Kind::Task, AttentionState::Unfinished),
            loose("tikk-dddd", Kind::Plan, AttentionState::Open),
            ticket("tikk-eeee", Kind::Task, AttentionState::Open),
        ]);

        assert_eq!(fixture.items(), [("tikk-aaaa".to_owned(), "looseTask")]);
    }

    #[test]
    fn a_merged_unverified_slice_carries_its_pr() {
        let mut fixture = Fixture::new(vec![
            ticket("tikk-aaaa", Kind::Slice, AttentionState::MergedUnverified),
            ticket("tikk-bbbb", Kind::Slice, AttentionState::Finished),
        ]);
        fixture.prs.insert(id("tikk-aaaa"), merged_pr());
        fixture.prs.insert(id("tikk-bbbb"), merged_pr());

        let listed = attention(AttentionInput {
            tickets: &fixture.tickets,
            questions: &fixture.questions,
            claims: &fixture.claims,
            prs: &fixture.prs,
            problems: Vec::new(),
            now: at("2026-11-13T12:00:00Z"),
        });

        assert_eq!(
            listed.items,
            [AttentionItem {
                id: id("tikk-aaaa"),
                reason: AttentionReason::MergedUnverified { pr: merged_pr() },
            }]
        );
    }

    #[test]
    fn items_are_ordered_by_reason_then_ticket_then_item_and_problems_pass_through() {
        let mut fixture = Fixture::new(vec![
            AttentionTicket {
                parent: None,
                ..ticket("tikk-aaaa", Kind::Task, AttentionState::Open)
            },
            ticket("tikk-bbbb", Kind::Slice, AttentionState::MergedUnverified),
        ]);
        fixture.prs.insert(id("tikk-bbbb"), merged_pr());
        fixture
            .claims
            .insert(id("tikk-zzzz"), claim("manager", "2026-11-13T04:00:00Z"));
        fixture
            .questions
            .insert(id("tikk-zzzz"), vec![question("cccc", false)]);
        fixture.questions.insert(
            id("tikk-bbbb"),
            vec![question("dddd", false), question("cccc", false)],
        );
        let problem = AttentionProblem::SyncFailed {
            at: None,
            message: "Sync stopped.".to_owned(),
            files: vec!["tickets/tikk/tikk-aaaa.md".to_owned()],
        };

        let listed = attention(AttentionInput {
            tickets: &fixture.tickets,
            questions: &fixture.questions,
            claims: &fixture.claims,
            prs: &fixture.prs,
            problems: vec![problem.clone()],
            now: at("2026-11-13T12:00:00Z"),
        });

        let order: Vec<(String, &str, Option<String>)> = listed
            .items
            .iter()
            .map(|item| {
                (
                    item.id.to_string(),
                    item.reason.as_str(),
                    item.reason.item().map(ToString::to_string),
                )
            })
            .collect();
        assert_eq!(
            order,
            [
                ("tikk-bbbb".to_owned(), "question", Some("cccc".to_owned())),
                ("tikk-bbbb".to_owned(), "question", Some("dddd".to_owned())),
                ("tikk-zzzz".to_owned(), "question", Some("cccc".to_owned())),
                ("tikk-zzzz".to_owned(), "staleClaim", None),
                ("tikk-aaaa".to_owned(), "looseTask", None),
                ("tikk-bbbb".to_owned(), "mergedUnverified", None),
            ]
        );
        assert_eq!(listed.problems, [problem]);
    }
}
