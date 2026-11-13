use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::fact::{Claim, Timestamp, current_claims};
use crate::store::fact_files::{UnreadableFact, read_facts};
use crate::store::project_choice::choose_project;
use crate::store::store_lock::{self, LockAccess, StoreLock};
use crate::store::system;
use crate::store::ticket_files::{StoredTicket, TicketScan, UnreadableTicket, read_tickets};
use crate::store::ticket_queries::{find_ticket, list_order};
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
            read_origin_url: system::read_origin_url,
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
    pub candidates: Vec<StoredTicket>,
    pub skipped: Vec<SkippedSlice>,
    pub errors: Vec<UnreadableTicket>,
    pub fact_errors: Vec<UnreadableFact>,
}

#[derive(Debug)]
pub struct SkippedSlice {
    pub ticket: StoredTicket,
    pub holds: Vec<Hold>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Hold {
    Draft,
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockerState {
    Open,
    Draft,
    Canceled,
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
            Self::Missing => "missing",
            Self::Unreadable => "unreadable",
            Self::Shared => "shared",
        }
    }
}

enum Lookup<'a> {
    Found(&'a StoredTicket),
    Unreadable,
    Shared,
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
    let lookups = index_tickets(&scan);
    let claims = current_claims(&facts.facts);
    let mut slices: Vec<&StoredTicket> = scan
        .tickets
        .iter()
        .filter(|ticket| is_open_or_draft_slice(ticket) && in_scope.contains(ticket))
        .collect();

    slices.sort_by(|left, right| list_order(left, right));

    let mut candidates = Vec::new();
    let mut skipped = Vec::new();

    for slice in slices {
        let mut holds = blocking_holds(slice, &lookups);

        if let Some(claim) = claims.get(&slice.id).filter(|claim| claim.is_live(now)) {
            holds.push(Hold::Claimed(claim.clone()));
        }

        if holds.is_empty() {
            candidates.push(slice.clone());
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

fn index_tickets(scan: &TicketScan) -> HashMap<&TicketId, Lookup<'_>> {
    let mut lookups = HashMap::new();
    let parsed = scan
        .tickets
        .iter()
        .map(|ticket| (&ticket.id, Lookup::Found(ticket)));
    let broken = scan
        .errors
        .iter()
        .filter_map(|error| error.id.as_ref())
        .map(|id| (id, Lookup::Unreadable));

    for (id, lookup) in parsed.chain(broken) {
        lookups
            .entry(id)
            .and_modify(|existing| *existing = Lookup::Shared)
            .or_insert(lookup);
    }

    lookups
}

fn blocking_holds(slice: &StoredTicket, lookups: &HashMap<&TicketId, Lookup<'_>>) -> Vec<Hold> {
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
        match found(lookups.get(parent)) {
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

    for (blocker, via) in named {
        if !seen.insert(blocker) {
            continue;
        }

        if let Some(state) = blocker_state(lookups.get(blocker)) {
            holds.push(Hold::BlockedBy {
                blocker: blocker.clone(),
                via: via.cloned(),
                state,
            });
        }
    }

    holds
}

fn plan_hold(status: Status) -> Option<BlockerState> {
    match status {
        Status::Draft => Some(BlockerState::Draft),
        Status::Canceled => Some(BlockerState::Canceled),
        Status::Open | Status::Done => None,
    }
}

fn blocker_state(lookup: Option<&Lookup<'_>>) -> Option<BlockerState> {
    match found(lookup) {
        Ok(ticket) => match ticket.document.fields.status() {
            Status::Done | Status::Canceled => None,
            Status::Open => Some(BlockerState::Open),
            Status::Draft => Some(BlockerState::Draft),
        },
        Err(state) => Some(state),
    }
}

fn found<'a>(lookup: Option<&Lookup<'a>>) -> Result<&'a StoredTicket, BlockerState> {
    match lookup {
        Some(Lookup::Found(ticket)) => Ok(ticket),
        Some(Lookup::Unreadable) => Err(BlockerState::Unreadable),
        Some(Lookup::Shared) => Err(BlockerState::Shared),
        None => Err(BlockerState::Missing),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::SystemTime;

    use tempfile::TempDir;

    use super::{BlockerState, Hold, ReadyEffects, ReadyQueue, ReadyScope, ready_slices};
    use crate::fact::Timestamp;
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

    fn store_with(files: &[(&str, String)]) -> (TempDir, Store) {
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
            .map(|ticket| ticket.id.to_string())
            .collect()
    }

    fn skipped(queue: &ReadyQueue) -> Vec<(String, Vec<Hold>)> {
        queue
            .skipped
            .iter()
            .map(|skipped| (skipped.ticket.id.to_string(), skipped.holds.clone()))
            .collect()
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
    fn a_slice_is_held_once_by_each_open_blocker_of_its_own_and_of_its_plan() {
        let (_directory, store) = store_with(&[
            (
                "personal-pppp-plan.md",
                plan("open", "personal-xxxx, personal-yyyy"),
            ),
            (
                "personal-kkkk-slice.md",
                slice(
                    "personal-pppp",
                    "open",
                    "personal-xxxx, personal-zzzz, personal-mmmm, personal-rrrr",
                ),
            ),
            ("personal-xxxx-x.md", task("open", "")),
            ("personal-yyyy-y.md", task("open", "")),
            ("personal-zzzz-z.md", task("done", "")),
            ("personal-rrrr-r.md", task("canceled", "")),
        ]);

        let queue = ready_under(&store, "personal-pppp").expect("the queue is read");

        let blocked = |blocker: &str, via: Option<&str>, state| Hold::BlockedBy {
            blocker: id(blocker),
            via: via.map(id),
            state,
        };
        assert_eq!(candidate_ids(&queue), Vec::<String>::new());
        assert_eq!(
            skipped(&queue),
            [(
                "personal-kkkk".to_owned(),
                vec![
                    blocked("personal-xxxx", None, BlockerState::Open),
                    blocked("personal-mmmm", None, BlockerState::Missing),
                    blocked("personal-yyyy", Some("personal-pppp"), BlockerState::Open),
                ]
            )]
        );
    }

    #[test]
    fn a_slice_is_held_by_a_draft_or_canceled_plan_and_not_by_an_open_one() {
        let (_directory, store) = store_with(&[
            ("personal-dddd-plan.md", plan("draft", "")),
            ("personal-cccc-plan.md", plan("canceled", "")),
            ("personal-nnnn-plan.md", plan("open", "")),
            ("personal-aaaa-a.md", slice("personal-dddd", "open", "")),
            ("personal-bbbb-b.md", slice("personal-cccc", "open", "")),
            ("personal-eeee-e.md", slice("personal-nnnn", "open", "")),
        ]);
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
            let queue = ready_under(&store, plan).expect("the queue is read");

            match state {
                Some(state) => {
                    assert_eq!(
                        skipped(&queue),
                        [(
                            slice.to_owned(),
                            vec![Hold::Parent {
                                parent: id(plan),
                                state
                            }]
                        )],
                        "case {plan}"
                    );
                    assert!(queue.candidates.is_empty(), "case {plan}");
                }
                None => assert_eq!(candidate_ids(&queue), [slice], "case {plan}"),
            }
        }
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
