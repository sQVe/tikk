use std::collections::HashMap;

use crate::fact::{FactLine, PrState, ShownAudit, ShownPr, Verdict, last_audits};
use crate::store::ticket_files::{StoredTicket, TicketScan};
use crate::store::ticket_queries::{TicketIndex, TicketLookup};
use crate::ticket::{Criterion, Kind, Status, TicketId};

/// The state of a plan or a slice that tikk derives from its file and the facts. Only an open plan
/// or slice derives a state of its own; the others keep their stored status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DerivedStatus {
    Draft,
    Open,
    AuditBehind,
    MergedUnverified,
    Done,
    Canceled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuditReason {
    NotLinked,
    RepositoryDiffers,
    HeadDiffers,
    CriterionMissing(String),
    CriterionChanged(String),
    NotMet(String),
}

/// A slice's last audit and each reason it does not count. It counts when there is no reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditCheck {
    pub audit: ShownAudit,
    pub reasons: Vec<AuditReason>,
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

impl AuditReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::NotLinked => "notLinked",
            Self::RepositoryDiffers => "repositoryDiffers",
            Self::HeadDiffers => "headDiffers",
            Self::CriterionMissing(_) => "criterionMissing",
            Self::CriterionChanged(_) => "criterionChanged",
            Self::NotMet(_) => "notMet",
        }
    }

    pub fn criterion(&self) -> Option<&str> {
        match self {
            Self::NotLinked | Self::RepositoryDiffers | Self::HeadDiffers => None,
            Self::CriterionMissing(criterion)
            | Self::CriterionChanged(criterion)
            | Self::NotMet(criterion) => Some(criterion),
        }
    }
}

impl AuditCheck {
    pub fn counts(&self) -> bool {
        self.reasons.is_empty()
    }
}

impl DerivedStates {
    /// The derived state of a plan or a slice, or `None` for a task or an instruction.
    pub fn status(&self, ticket: &StoredTicket) -> Option<DerivedStatus> {
        matches!(ticket.document.fields.kind(), Kind::Plan | Kind::Slice)
            .then(|| self.effective(ticket))
    }

    pub fn audit(&self, slice: &TicketId) -> Option<&AuditCheck> {
        self.audits.get(slice)
    }

    // A shared ID derives nothing, since tikk cannot tell which file a fact belongs to.
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
    facts: &[FactLine],
    prs: &HashMap<TicketId, ShownPr>,
) -> DerivedStates {
    let index = TicketIndex::new(scan);
    let mut audits = last_audits(facts);
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

        states
            .statuses
            .insert(slice.id.clone(), slice_status(pr, check.as_ref()));

        if let Some(check) = check {
            states.audits.insert(slice.id.clone(), check);
        }
    }

    for plan in scan.tickets.iter().filter(only_file) {
        if plan.document.fields.kind() == Kind::Plan {
            let status = plan_status(&plan.id, scan, &states);

            states.statuses.insert(plan.id.clone(), status);
        }
    }

    states
}

fn check_audit(audit: ShownAudit, criteria: &[Criterion], pr: Option<&ShownPr>) -> AuditCheck {
    let mut reasons = Vec::new();

    match pr.map(|pr| &pr.observation) {
        None => reasons.push(AuditReason::NotLinked),
        Some(observation) => {
            if observation.pull_request.repository() != audit.audit.repository.as_str() {
                reasons.push(AuditReason::RepositoryDiffers);
            }

            if observation.head != audit.audit.head {
                reasons.push(AuditReason::HeadDiffers);
            }
        }
    }

    for criterion in criteria {
        let verdict = audit
            .audit
            .verdicts
            .iter()
            .find(|verdict| verdict.criterion == criterion.id);
        let Some(verdict) = verdict else {
            reasons.push(AuditReason::CriterionMissing(criterion.id.clone()));
            continue;
        };
        let same_text = verdict.check == criterion.check && verdict.expected == criterion.expected;

        if !same_text {
            reasons.push(AuditReason::CriterionChanged(criterion.id.clone()));
        }

        if verdict.verdict != Verdict::Met {
            reasons.push(AuditReason::NotMet(criterion.id.clone()));
        }
    }

    AuditCheck { audit, reasons }
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

// The caller derives the slices first.
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

    use super::{AuditReason, DerivedStates, DerivedStatus, derive_states};
    use crate::fact::{
        Audit, AuditVerdict, FactEvent, FactLine, PrObservation, PrState, PullRequest, Repository,
        Timestamp, Verdict, current_prs,
    };
    use crate::store::ticket_files::{StoredTicket, TicketScan};
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
        derive_states(scan, facts, &current_prs(facts))
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
    fn an_audit_lists_each_reason_it_does_not_count() {
        let two = "criteria:\n  - id: s2\n    check: c\n    expected: e\n";
        let tickets = vec![
            plan(),
            ticket(
                "personal-kkkk",
                &format!(
                    "kind: slice\ntitle: Slice\nparent: personal-pppp\n{CRITERIA}{}",
                    two.trim_start_matches("criteria:\n")
                ),
            ),
        ];
        let cases = [
            (
                "another repository and head",
                audit(
                    "personal-kkkk",
                    "owner/other",
                    "old",
                    &[("s1", "e", Verdict::Met), ("s2", "e", Verdict::Met)],
                ),
                vec![AuditReason::RepositoryDiffers, AuditReason::HeadDiffers],
            ),
            (
                "a changed, a missing, and a not-run criterion",
                audit(
                    "personal-kkkk",
                    "owner/app",
                    "head",
                    &[("s1", "old", Verdict::NotRun), ("gone", "e", Verdict::Met)],
                ),
                vec![
                    AuditReason::CriterionChanged("s1".to_owned()),
                    AuditReason::NotMet("s1".to_owned()),
                    AuditReason::CriterionMissing("s2".to_owned()),
                ],
            ),
        ];

        for (name, audit, expected) in cases {
            let states = derived(&scan(tickets.clone()), &[merged(), audit]);
            let check = states
                .audit(&id("personal-kkkk"))
                .expect("the slice has an audit");

            assert_eq!(check.reasons, expected, "case {name}");
            assert!(!check.counts(), "case {name}");
        }
    }

    #[test]
    fn an_audit_of_a_slice_without_a_pr_does_not_count() {
        let states = derived(&scan(vec![plan(), slice("personal-kkkk", "")]), &[met()]);

        let check = states
            .audit(&id("personal-kkkk"))
            .expect("the slice has an audit");

        assert_eq!(check.reasons, vec![AuditReason::NotLinked]);
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
    fn each_derived_status_and_reason_has_its_json_name_and_criterion() {
        let statuses = [
            (DerivedStatus::Draft, "draft"),
            (DerivedStatus::Open, "open"),
            (DerivedStatus::AuditBehind, "auditBehind"),
            (DerivedStatus::MergedUnverified, "mergedUnverified"),
            (DerivedStatus::Done, "done"),
            (DerivedStatus::Canceled, "canceled"),
        ];
        let criterion = || "s1".to_owned();
        let reasons = [
            (AuditReason::NotLinked, "notLinked", None),
            (AuditReason::RepositoryDiffers, "repositoryDiffers", None),
            (AuditReason::HeadDiffers, "headDiffers", None),
            (
                AuditReason::CriterionMissing(criterion()),
                "criterionMissing",
                Some("s1"),
            ),
            (
                AuditReason::CriterionChanged(criterion()),
                "criterionChanged",
                Some("s1"),
            ),
            (AuditReason::NotMet(criterion()), "notMet", Some("s1")),
        ];

        for (status, name) in statuses {
            assert_eq!(status.as_str(), name, "case {status:?}");
        }

        for (reason, name, expected) in reasons {
            assert_eq!(reason.as_str(), name, "case {reason:?}");
            assert_eq!(reason.criterion(), expected, "case {reason:?}");
        }
    }
}
