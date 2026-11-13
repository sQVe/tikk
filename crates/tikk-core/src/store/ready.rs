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

/// The slices to weigh: the plan's, or else the project's. Without either, the project is the
/// one `tikk new` would choose in the working directory.
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
    /// `via` names the plan whose `blockedBy` holds the blocker.
    BlockedBy {
        blocker: TicketId,
        via: Option<TicketId>,
        state: BlockerState,
    },
    /// The slice's plan cannot be read, so its blockers are unknown.
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
    Missing,
    Unreadable,
    Shared,
}

impl BlockerState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Draft => "draft",
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

/// Candidates and skipped slices are in rank order, then by ID. Done and canceled slices are not
/// listed.
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

// A blocker that the slice and its plan both name is listed once, at the slice.
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
            Ok(plan) => named.extend(
                plan.document
                    .fields
                    .blocked_by()
                    .iter()
                    .map(|blocker| (blocker, Some(parent))),
            ),
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

// A done or canceled blocker no longer holds.
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
