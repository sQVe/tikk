use std::collections::HashMap;

use crate::fact::{PrState, ShownPr, last_audits};
use crate::store::audit_check::{AuditCheck, check_audit};
use crate::store::fact_files::FactScan;
use crate::store::ticket_files::{StoredTicket, TicketScan};
use crate::store::ticket_queries::{TicketIndex, TicketLookup};
use crate::ticket::{Kind, Status, TicketId};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DerivedStatus {
    Draft,
    Open,
    AuditBehind,
    MergedUnverified,
    Done,
    Canceled,
}

#[derive(Debug, Default)]
pub struct DerivedStates {
    statuses: HashMap<TicketId, DerivedStatus>,
    audits: HashMap<TicketId, AuditCheck>,
}

impl DerivedStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Open => "open",
            Self::AuditBehind => "auditBehind",
            Self::MergedUnverified => "mergedUnverified",
            Self::Done => "done",
            Self::Canceled => "canceled",
        }
    }

    fn stored(status: Status) -> Self {
        match status {
            Status::Draft => Self::Draft,
            Status::Open => Self::Open,
            Status::Done => Self::Done,
            Status::Canceled => Self::Canceled,
        }
    }
}

impl DerivedStates {
    pub fn status(&self, ticket: &StoredTicket) -> Option<DerivedStatus> {
        matches!(ticket.document.fields.kind(), Kind::Plan | Kind::Slice)
            .then(|| self.effective(ticket))
    }

    pub fn audit(&self, slice: &TicketId) -> Option<&AuditCheck> {
        self.audits.get(slice)
    }

    pub(crate) fn effective(&self, ticket: &StoredTicket) -> DerivedStatus {
        let stored = ticket.document.fields.status();

        if stored != Status::Open {
            return DerivedStatus::stored(stored);
        }

        self.statuses
            .get(&ticket.id)
            .copied()
            .unwrap_or(DerivedStatus::Open)
    }
}

// `prs` is the `current_prs` of the same facts.
pub(crate) fn derive_states(
    scan: &TicketScan,
    facts: &FactScan,
    prs: &HashMap<TicketId, ShownPr>,
) -> DerivedStates {
    let index = TicketIndex::new(scan);
    let mut audits = last_audits(&facts.facts);
    let mut states = DerivedStates::default();
    let only_file =
        |ticket: &&StoredTicket| matches!(index.look_up(&ticket.id), TicketLookup::Found(_));

    for slice in scan.tickets.iter().filter(only_file) {
        if slice.document.fields.kind() != Kind::Slice {
            continue;
        }

        let pr = prs.get(&slice.id);
        let check = audits
            .remove(&slice.id)
            .map(|audit| check_audit(audit, slice.document.fields.criteria(), pr));

        let mut status = slice_status(pr, check.as_ref());

        // An unreadable line may be a newer audit of this slice, so tikk cannot prove the last one.
        if status == DerivedStatus::Done && !facts.errors.is_empty() {
            status = DerivedStatus::MergedUnverified;
        }

        states.statuses.insert(slice.id.clone(), status);

        if let Some(check) = check {
            states.audits.insert(slice.id.clone(), check);
        }
    }

    for plan in scan.tickets.iter().filter(only_file) {
        if plan.document.fields.kind() == Kind::Plan {
            // An unreadable ticket file may be an unfinished child of this plan, and an unreadable
            // fact line may be a newer audit of one of its slices.
            let status = if scan.errors.is_empty() && facts.errors.is_empty() {
                plan_status(&plan.id, scan, &states)
            } else {
                DerivedStatus::Open
            };

            states.statuses.insert(plan.id.clone(), status);
        }
    }

    states
}

fn slice_status(pr: Option<&ShownPr>, check: Option<&AuditCheck>) -> DerivedStatus {
    let Some(pr) = pr else {
        return DerivedStatus::Open;
    };
    let observation = &pr.observation;

    if observation.in_trunk {
        return if check.is_some_and(AuditCheck::counts) {
            DerivedStatus::Done
        } else {
            DerivedStatus::MergedUnverified
        };
    }

    let behind = check.is_some_and(|check| check.audit.audit.head != observation.head);

    if pr.state() == PrState::Open && behind {
        return DerivedStatus::AuditBehind;
    }

    DerivedStatus::Open
}

fn plan_status(plan: &TicketId, scan: &TicketScan, states: &DerivedStates) -> DerivedStatus {
    let mut has_member = false;

    for child in &scan.tickets {
        if child.id == *plan || child.document.fields.parent() != Some(plan) {
            continue;
        }

        let fields = &child.document.fields;
        let status = match fields.kind() {
            Kind::Slice => states.effective(child),
            Kind::Task => DerivedStatus::stored(fields.status()),
            Kind::Plan | Kind::Instruction => continue,
        };

        match status {
            DerivedStatus::Canceled => {}
            DerivedStatus::Done => has_member = true,
            _ => return DerivedStatus::Open,
        }
    }

    if has_member {
        DerivedStatus::Done
    } else {
        DerivedStatus::Open
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{DerivedStates, DerivedStatus, derive_states};
    use crate::fact::{
        Audit, AuditVerdict, FactEvent, FactLine, PrObservation, PrState, PullRequest, Repository,
        Timestamp, Verdict, current_prs,
    };
    use crate::store::audit_check::AuditReason;
    use crate::store::fact_files::{FactScan, UnreadableFact};
    use crate::store::ticket_files::{StoredTicket, TicketScan, UnreadableTicket};
    use crate::ticket::{TicketDocument, TicketId};

    const CRITERIA: &str = "criteria:\n  - id: s1\n    check: c\n    expected: e\n";

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

    fn plan() -> StoredTicket {
        ticket("personal-pppp", "kind: plan\ntitle: Plan\n")
    }

    fn slice(name: &str, extra: &str) -> StoredTicket {
        ticket(
            name,
            &format!("kind: slice\ntitle: Slice\nparent: personal-pppp\n{extra}{CRITERIA}"),
        )
    }

    fn scan(tickets: Vec<StoredTicket>) -> TicketScan {
        TicketScan {
            tickets,
            errors: Vec::new(),
        }
    }

    fn pr(slice: &str, state: PrState, head: &str, in_trunk: bool) -> FactLine {
        FactLine {
            ticket: id(slice),
            at: Timestamp::parse("2026-11-13T01:00:00Z").expect("a valid time"),
            event: FactEvent::Pr(PrObservation {
                pull_request: PullRequest::new("owner/app", 7).expect("a valid PR"),
                state,
                base: "main".to_owned(),
                head: head.to_owned(),
                merge_commit: in_trunk.then(|| "merge".to_owned()),
                in_trunk,
            }),
        }
    }

    fn audit(
        slice: &str,
        repository: &str,
        head: &str,
        verdicts: &[(&str, &str, Verdict)],
    ) -> FactLine {
        FactLine {
            ticket: id(slice),
            at: Timestamp::parse("2026-11-13T02:00:00Z").expect("a valid time"),
            event: FactEvent::Audit(Audit {
                repository: Repository::parse(repository).expect("a valid repository"),
                head: head.to_owned(),
                ticket_hash: "hash".to_owned(),
                verdicts: verdicts
                    .iter()
                    .map(|(criterion, expected, verdict)| AuditVerdict {
                        criterion: (*criterion).to_owned(),
                        check: "c".to_owned(),
                        expected: (*expected).to_owned(),
                        verdict: *verdict,
                        evidence: "seen".to_owned(),
                    })
                    .collect(),
            }),
        }
    }

    fn derived(scan: &TicketScan, facts: &[FactLine]) -> DerivedStates {
        let facts = FactScan {
            facts: facts.to_vec(),
            errors: Vec::new(),
        };

        derive_states(scan, &facts, &current_prs(&facts.facts))
    }

    fn merged() -> FactLine {
        pr("personal-kkkk", PrState::Merged, "head", true)
    }

    fn met() -> FactLine {
        audit(
            "personal-kkkk",
            "owner/app",
            "head",
            &[("s1", "e", Verdict::Met)],
        )
    }

    #[test]
    fn a_slice_derives_its_state_from_its_pr_and_its_last_audit() {
        let cases = [
            ("no PR", vec![], DerivedStatus::Open),
            (
                "an open PR, no audit",
                vec![pr("personal-kkkk", PrState::Open, "head", false)],
                DerivedStatus::Open,
            ),
            (
                "an open PR, an audit of its head",
                vec![pr("personal-kkkk", PrState::Open, "head", false), met()],
                DerivedStatus::Open,
            ),
            (
                "an open PR, an audit of another head",
                vec![pr("personal-kkkk", PrState::Open, "new", false), met()],
                DerivedStatus::AuditBehind,
            ),
            (
                "a closed PR, an audit of another head",
                vec![pr("personal-kkkk", PrState::Closed, "new", false), met()],
                DerivedStatus::Open,
            ),
            (
                "in trunk, no audit",
                vec![merged()],
                DerivedStatus::MergedUnverified,
            ),
            (
                "in trunk, an audit that counts",
                vec![merged(), met()],
                DerivedStatus::Done,
            ),
            (
                "in trunk, an audit with not-met",
                vec![
                    merged(),
                    audit(
                        "personal-kkkk",
                        "owner/app",
                        "head",
                        &[("s1", "e", Verdict::NotMet)],
                    ),
                ],
                DerivedStatus::MergedUnverified,
            ),
        ];

        for (name, facts, expected) in cases {
            let states = derived(&scan(vec![plan(), slice("personal-kkkk", "")]), &facts);
            let derived = states.status(&slice("personal-kkkk", ""));

            assert_eq!(derived, Some(expected), "case {name}");
        }
    }

    #[test]
    fn a_slice_keeps_the_check_of_its_last_audit() {
        let tickets = vec![
            plan(),
            slice("personal-kkkk", ""),
            slice("personal-rrrr", ""),
        ];

        let states = derived(&scan(tickets), &[met()]);
        let check = states
            .audit(&id("personal-kkkk"))
            .expect("the slice has an audit");

        assert_eq!(check.reasons, vec![AuditReason::NotLinked]);
        assert_eq!(states.audit(&id("personal-rrrr")), None);
    }

    #[test]
    fn no_slice_or_plan_is_done_while_a_fact_line_is_unreadable() {
        let tickets = vec![
            plan(),
            slice("personal-kkkk", ""),
            slice("personal-rrrr", ""),
        ];
        let behind = pr("personal-rrrr", PrState::Open, "new", false);
        let mut behind_audit = met();
        behind_audit.ticket = id("personal-rrrr");
        let facts = FactScan {
            facts: vec![merged(), met(), behind, behind_audit],
            errors: vec![UnreadableFact {
                path: PathBuf::from("facts/2026-11.jsonl"),
                line: 3,
                message: "the line is not JSON".to_owned(),
            }],
        };

        let states = derive_states(&scan(tickets), &facts, &current_prs(&facts.facts));

        assert_eq!(
            states.status(&slice("personal-kkkk", "")),
            Some(DerivedStatus::MergedUnverified)
        );
        assert_eq!(
            states.status(&slice("personal-rrrr", "")),
            Some(DerivedStatus::AuditBehind)
        );
        assert_eq!(states.status(&plan()), Some(DerivedStatus::Open));
    }

    #[test]
    fn a_plan_of_done_tasks_is_not_done_while_a_fact_line_is_unreadable() {
        let done_task = ticket(
            "personal-tttt",
            "kind: task\ntitle: Task\nparent: personal-pppp\nstatus: done\n",
        );
        let tickets = scan(vec![plan(), done_task]);
        let facts = FactScan {
            facts: Vec::new(),
            errors: vec![UnreadableFact {
                path: PathBuf::from("facts/2026-11.jsonl"),
                line: 1,
                message: "the line is not JSON".to_owned(),
            }],
        };

        let states = derive_states(&tickets, &facts, &current_prs(&facts.facts));

        assert_eq!(states.status(&plan()), Some(DerivedStatus::Open));
    }

    #[test]
    fn no_plan_is_done_while_a_ticket_file_is_unreadable() {
        let done_task = ticket(
            "personal-tttt",
            "kind: task\ntitle: Task\nparent: personal-pppp\nstatus: done\n",
        );
        let mut tickets = scan(vec![plan(), slice("personal-kkkk", ""), done_task]);
        tickets.errors.push(UnreadableTicket {
            path: PathBuf::from("tickets/personal/personal-rrrr.md"),
            id: Some(id("personal-rrrr")),
            message: "the front matter is not YAML".to_owned(),
        });

        let states = derived(&tickets, &[merged(), met()]);

        assert_eq!(states.status(&plan()), Some(DerivedStatus::Open));
        assert_eq!(
            states.status(&slice("personal-kkkk", "")),
            Some(DerivedStatus::Done)
        );
    }

    #[test]
    fn a_draft_or_canceled_slice_keeps_its_stored_status() {
        let cases = [
            ("status: draft\n", DerivedStatus::Draft),
            (
                "status: canceled\nreason: Dropped\n",
                DerivedStatus::Canceled,
            ),
        ];

        for (extra, expected) in cases {
            let tickets = vec![plan(), slice("personal-kkkk", extra)];
            let states = derived(&scan(tickets), &[merged(), met()]);

            assert_eq!(
                states.status(&slice("personal-kkkk", extra)),
                Some(expected),
                "case {extra}"
            );
        }
    }

    #[test]
    fn a_shared_slice_id_derives_nothing() {
        let tickets = vec![
            plan(),
            slice("personal-kkkk", ""),
            slice("personal-kkkk", ""),
        ];

        let states = derived(&scan(tickets), &[merged(), met()]);

        assert_eq!(
            states.status(&slice("personal-kkkk", "")),
            Some(DerivedStatus::Open)
        );
    }

    #[test]
    fn an_open_plan_is_done_when_its_members_are() {
        let task = |name: &str, status: &str| {
            ticket(
                name,
                &format!(
                    "kind: task\ntitle: Task\nparent: personal-pppp\nstatus: {status}\n{}",
                    if status == "canceled" {
                        "reason: Dropped\n"
                    } else {
                        ""
                    }
                ),
            )
        };
        let canceled_slice = slice("personal-cccc", "status: canceled\nreason: Dropped\n");
        let cases = [
            ("no member", vec![], DerivedStatus::Open),
            (
                "a done slice",
                vec![slice("personal-kkkk", "")],
                DerivedStatus::Done,
            ),
            (
                "a done slice and a done and a canceled task",
                vec![
                    slice("personal-kkkk", ""),
                    task("personal-tttt", "done"),
                    task("personal-wwww", "canceled"),
                ],
                DerivedStatus::Done,
            ),
            (
                "a done slice and an open task",
                vec![slice("personal-kkkk", ""), task("personal-tttt", "open")],
                DerivedStatus::Open,
            ),
            (
                "a done slice and an open slice",
                vec![slice("personal-kkkk", ""), slice("personal-rrrr", "")],
                DerivedStatus::Open,
            ),
            (
                "only a canceled slice",
                vec![canceled_slice.clone()],
                DerivedStatus::Open,
            ),
            (
                "a done and a canceled slice",
                vec![slice("personal-kkkk", ""), canceled_slice],
                DerivedStatus::Done,
            ),
            (
                "a done slice and an open task under no plan",
                vec![
                    slice("personal-kkkk", ""),
                    ticket("personal-wwww", "kind: task\ntitle: Loose\n"),
                ],
                DerivedStatus::Done,
            ),
        ];

        for (name, children, expected) in cases {
            let mut tickets = vec![plan()];
            tickets.extend(children);

            let states = derived(&scan(tickets), &[merged(), met()]);

            assert_eq!(states.status(&plan()), Some(expected), "case {name}");
        }
    }

    #[test]
    fn a_draft_plan_keeps_its_stored_status_and_a_task_derives_nothing() {
        let draft = ticket("personal-pppp", "kind: plan\ntitle: Plan\nstatus: draft\n");
        let task = ticket("personal-tttt", "kind: task\ntitle: Task\n");
        let tickets = vec![draft.clone(), slice("personal-kkkk", ""), task.clone()];

        let states = derived(&scan(tickets), &[merged(), met()]);

        assert_eq!(states.status(&draft), Some(DerivedStatus::Draft));
        assert_eq!(states.status(&task), None);
    }

    #[test]
    fn each_derived_status_has_its_json_name() {
        let statuses = [
            (DerivedStatus::Draft, "draft"),
            (DerivedStatus::Open, "open"),
            (DerivedStatus::AuditBehind, "auditBehind"),
            (DerivedStatus::MergedUnverified, "mergedUnverified"),
            (DerivedStatus::Done, "done"),
            (DerivedStatus::Canceled, "canceled"),
        ];

        for (status, name) in statuses {
            assert_eq!(status.as_str(), name, "case {status:?}");
        }
    }
}
