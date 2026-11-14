use std::path::{Path, PathBuf};

use crate::fact::{Timestamp, current_claims, current_prs};
use crate::store::derived_state::{DerivedStatus, derive_states};
use crate::store::fact_files::{UnreadableFact, read_facts};
use crate::store::git;
use crate::store::project_choice::choose_project;
use crate::store::ready_holds::{Hold, StackParent, blocking_holds};
use crate::store::store_lock::{self, LockAccess, StoreLock};
use crate::store::system;
use crate::store::ticket_files::{StoredTicket, TicketScan, UnreadableTicket, read_tickets};
use crate::store::ticket_index::{TicketIndex, TicketLookup, find_ticket};
use crate::store::ticket_queries::list_order;
use crate::store::{Store, StoreError};
use crate::ticket::{Kind, ProjectName, Status, TicketId};

#[derive(Clone, Copy)]
pub struct ReadyEffects {
    pub lock_store: fn(&Path, LockAccess) -> Result<StoreLock, StoreError>,
    pub read_origin_url: fn(&Path) -> Result<Option<String>, StoreError>,
    pub now: fn() -> Timestamp,
}

impl ReadyEffects {
    pub fn system() -> Self {
        Self {
            lock_store: store_lock::lock_store,
            read_origin_url: git::read_origin_url,
            now: system::now,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ReadyScope {
    pub parent: Option<TicketId>,
    pub project: Option<ProjectName>,
    pub working_directory: PathBuf,
}

#[derive(Debug)]
pub struct ReadyQueue {
    pub candidates: Vec<ReadySlice>,
    pub skipped: Vec<SkippedSlice>,
    pub errors: Vec<UnreadableTicket>,
    pub fact_errors: Vec<UnreadableFact>,
}

#[derive(Debug)]
pub struct ReadySlice {
    pub ticket: StoredTicket,
    pub stack_parent: Option<StackParent>,
}

#[derive(Debug)]
pub struct SkippedSlice {
    pub ticket: StoredTicket,
    pub holds: Vec<Hold>,
}

pub fn ready_slices(
    store: &Store,
    scope: ReadyScope,
    effects: &ReadyEffects,
) -> Result<ReadyQueue, StoreError> {
    let (scan, facts) = {
        let _lock = (effects.lock_store)(store.root(), LockAccess::Shared)?;

        (read_tickets(store.root())?, read_facts(store.root())?)
    };
    let in_scope = scope_filter(&scan, scope, effects)?;
    let now = (effects.now)();
    let lookups = TicketIndex::new(&scan);
    let claims = current_claims(&facts.facts);
    let prs = current_prs(&facts.facts);
    let derived = derive_states(&scan, &facts, &prs);
    let mut slices: Vec<&StoredTicket> = scan
        .tickets
        .iter()
        .filter(|ticket| is_open_or_draft_slice(ticket) && in_scope.contains(ticket))
        .collect();

    slices.sort_by(|left, right| list_order(left, right));

    let mut candidates = Vec::new();
    let mut skipped = Vec::new();

    for slice in slices {
        let status = derived.effective(slice);

        if status == DerivedStatus::Done {
            continue;
        }

        if let TicketLookup::Shared(paths) = lookups.look_up(&slice.id) {
            skipped.push(SkippedSlice {
                ticket: slice.clone(),
                holds: vec![Hold::IdShared {
                    paths: paths.into_iter().map(Path::to_path_buf).collect(),
                }],
            });
            continue;
        }

        let (mut holds, stack_parent) = blocking_holds(slice, &lookups, &prs, &derived);

        if status == DerivedStatus::MergedUnverified {
            holds.insert(0, Hold::MergedUnverified);
        }

        if let Some(claim) = claims.get(&slice.id).filter(|claim| claim.is_live(now)) {
            holds.push(Hold::Claimed(claim.clone()));
        }

        if holds.is_empty() {
            candidates.push(ReadySlice {
                ticket: slice.clone(),
                stack_parent,
            });
        } else {
            skipped.push(SkippedSlice {
                ticket: slice.clone(),
                holds,
            });
        }
    }

    Ok(ReadyQueue {
        candidates,
        skipped,
        errors: scan.errors,
        fact_errors: facts.errors,
    })
}

enum ScopeFilter {
    Parent(TicketId),
    Project(ProjectName),
}

impl ScopeFilter {
    fn contains(&self, ticket: &StoredTicket) -> bool {
        match self {
            Self::Parent(parent) => ticket.document.fields.parent() == Some(parent),
            Self::Project(project) => ticket.id.project() == project,
        }
    }
}

fn scope_filter(
    scan: &TicketScan,
    scope: ReadyScope,
    effects: &ReadyEffects,
) -> Result<ScopeFilter, StoreError> {
    let Some(parent) = scope.parent else {
        let project = choose_project(
            scope.project,
            &scope.working_directory,
            effects.read_origin_url,
        )?;

        return Ok(ScopeFilter::Project(project));
    };
    let kind = find_ticket(scan, &parent)?.document.fields.kind();

    if kind != Kind::Plan {
        return Err(StoreError::WrongKind {
            id: parent.to_string(),
            kind,
            allowed: "a plan",
        });
    }

    Ok(ScopeFilter::Parent(parent))
}

fn is_open_or_draft_slice(ticket: &StoredTicket) -> bool {
    let fields = &ticket.document.fields;

    fields.kind() == Kind::Slice && matches!(fields.status(), Status::Open | Status::Draft)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::SystemTime;

    use super::{Hold, ReadyEffects, ReadyQueue, ReadyScope, ready_slices};
    use crate::fact::{PrState, Timestamp};
    use crate::store::test_support::store_with;
    use crate::store::{Store, StoreError};
    use crate::ticket::{Kind, ProjectName, TicketId};

    const CRITERIA: &str = "criteria:\n  - id: s1\n    check: c\n    expected: e\n";

    fn no_origin(_: &Path) -> Result<Option<String>, StoreError> {
        Ok(None)
    }

    fn epoch() -> Timestamp {
        Timestamp::from_system_time(SystemTime::UNIX_EPOCH)
    }

    fn effects() -> ReadyEffects {
        ReadyEffects {
            read_origin_url: no_origin,
            now: epoch,
            ..ReadyEffects::system()
        }
    }

    fn reason(status: &str) -> &'static str {
        if status == "canceled" {
            "reason: Dropped\n"
        } else {
            ""
        }
    }

    fn plan(status: &str, blocked_by: &str) -> String {
        format!(
            "---\nkind: plan\ntitle: Plan\nstatus: {status}\n{}blockedBy: [{blocked_by}]\n---\n",
            reason(status)
        )
    }

    fn slice(parent: &str, status: &str, blocked_by: &str) -> String {
        format!(
            "---\nkind: slice\ntitle: Slice\nstatus: {status}\n{}parent: {parent}\nblockedBy: [{blocked_by}]\n{CRITERIA}---\n",
            reason(status)
        )
    }

    fn task(status: &str, parent: &str) -> String {
        format!(
            "---\nkind: task\ntitle: Task\nstatus: {status}\n{}{parent}---\n",
            reason(status)
        )
    }

    fn id(text: &str) -> TicketId {
        TicketId::parse(text).expect("a valid ID")
    }

    fn ready_under(store: &Store, parent: &str) -> Result<ReadyQueue, StoreError> {
        let scope = ReadyScope {
            parent: Some(id(parent)),
            project: None,
            working_directory: PathBuf::from("/work"),
        };

        ready_slices(store, scope, &effects())
    }

    fn candidate_ids(queue: &ReadyQueue) -> Vec<String> {
        queue
            .candidates
            .iter()
            .map(|candidate| candidate.ticket.id.to_string())
            .collect()
    }

    fn skipped(queue: &ReadyQueue) -> Vec<(String, Vec<Hold>)> {
        queue
            .skipped
            .iter()
            .map(|skipped| (skipped.ticket.id.to_string(), skipped.holds.clone()))
            .collect()
    }

    fn pr_facts(directory: &Path, facts: &[(&str, u64, &str)]) {
        let folder = directory.join("facts/test");
        let lines: String = facts
            .iter()
            .map(|(slice, number, state)| {
                format!(
                    "{{\"v\":1,\"kind\":\"pr\",\"ticket\":\"{slice}\",\"at\":\"2026-11-13T01:00:00Z\",\"repository\":\"owner/app\",\"number\":{number},\"state\":\"{state}\",\"base\":\"main\",\"head\":\"head-{number}\",\"mergeCommit\":null,\"inTrunk\":false}}\n"
                )
            })
            .collect();
        fs::create_dir_all(&folder).expect("create the machine folder");
        fs::write(folder.join("2026-11.jsonl"), lines).expect("write the PR facts");
    }

    #[test]
    fn a_slice_blocked_only_by_slices_with_open_prs_stacks_on_the_smallest_blocker() {
        let (directory, store) = store_with(&[
            ("personal-pppp-plan.md", plan("open", "")),
            ("personal-xxxx-x.md", slice("personal-pppp", "open", "")),
            ("personal-yyyy-y.md", slice("personal-pppp", "open", "")),
            (
                "personal-kkkk-k.md",
                slice("personal-pppp", "open", "personal-yyyy, personal-xxxx"),
            ),
        ]);
        pr_facts(
            directory.path(),
            &[("personal-xxxx", 7, "open"), ("personal-yyyy", 8, "open")],
        );

        let queue = ready_under(&store, "personal-pppp").expect("the queue is read");

        let stacked = queue
            .candidates
            .iter()
            .find(|candidate| candidate.ticket.id == id("personal-kkkk"))
            .expect("the stacked slice is a candidate");
        let parent = stacked
            .stack_parent
            .as_ref()
            .expect("it has a stack parent");
        assert_eq!(parent.slice, id("personal-xxxx"));
        assert_eq!(parent.pr.observation.pull_request.number(), 7);
        assert_eq!(parent.pr.state(), PrState::Open);
        assert_eq!(
            parent.pr.checked_at,
            Timestamp::parse("2026-11-13T01:00:00Z").expect("a valid time")
        );
        assert!(
            queue
                .candidates
                .iter()
                .filter(|candidate| candidate.ticket.id != id("personal-kkkk"))
                .all(|candidate| candidate.stack_parent.is_none())
        );
    }

    #[test]
    fn ready_in_a_project_offers_only_the_slices_of_that_project() {
        let (directory, store) = store_with(&[
            ("personal-pppp-plan.md", plan("open", "")),
            ("personal-aaaa-open.md", slice("personal-pppp", "open", "")),
        ]);
        let other = directory.path().join("tickets/tikk");
        fs::create_dir_all(&other).expect("create the other project folder");
        fs::write(other.join("tikk-qqqq-plan.md"), plan("open", "")).expect("write a plan");
        fs::write(
            other.join("tikk-bbbb-open.md"),
            slice("tikk-qqqq", "open", ""),
        )
        .expect("write a slice");
        let scope = ReadyScope {
            parent: None,
            project: Some(ProjectName::parse("tikk").expect("a valid project")),
            working_directory: PathBuf::from("/work"),
        };

        let queue = ready_slices(&store, scope, &effects()).expect("the queue is read");

        assert_eq!(candidate_ids(&queue), ["tikk-bbbb"]);
    }

    #[test]
    fn ready_offers_open_slices_skips_drafts_and_omits_other_kinds_and_canceled_slices() {
        let (_directory, store) = store_with(&[
            ("personal-pppp-plan.md", plan("open", "")),
            ("personal-aaaa-open.md", slice("personal-pppp", "open", "")),
            (
                "personal-dddd-draft.md",
                slice("personal-pppp", "draft", ""),
            ),
            (
                "personal-cccc-gone.md",
                slice("personal-pppp", "canceled", ""),
            ),
            (
                "personal-tttt-task.md",
                task("open", "parent: personal-pppp\n"),
            ),
        ]);

        let queue = ready_under(&store, "personal-pppp").expect("the queue is read");

        assert_eq!(candidate_ids(&queue), ["personal-aaaa"]);
        assert_eq!(
            skipped(&queue),
            [("personal-dddd".to_owned(), vec![Hold::Draft])]
        );
    }

    #[test]
    fn ready_parent_takes_a_plan_and_refuses_another_kind() {
        let (_directory, store) = store_with(&[
            ("personal-pppp-plan.md", plan("open", "")),
            ("personal-kkkk-slice.md", slice("personal-pppp", "open", "")),
        ]);

        let of_plan = ready_under(&store, "personal-pppp");
        let of_slice = ready_under(&store, "personal-kkkk");

        assert!(of_plan.is_ok(), "{of_plan:?}");
        assert!(
            matches!(
                &of_slice,
                Err(StoreError::WrongKind { id, kind: Kind::Slice, .. }) if id == "personal-kkkk"
            ),
            "{of_slice:?}"
        );
    }
}
