use std::collections::HashMap;
use std::path::Path;

use crate::fact::{PrObservation, PullRequest, ShownPr, current_prs};
use crate::store::fact_files::read_facts;
use crate::store::pr_github::{PrFailure, read_pull_request};
use crate::store::pr_link::{PrEffects, append_pr, check_linkable};
use crate::store::store_lock::LockAccess;
use crate::store::ticket_files::read_tickets;
use crate::store::ticket_queries::{TicketIndex, TicketLookup};
use crate::store::{Store, StoreError};
use crate::ticket::{Kind, TicketId};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshedPr {
    pub slice: TicketId,
    pub pr: ShownPr,
}

/// Reads through `gh` the PR of the named slice, or every linked PR not yet seen in trunk, and
/// appends a `pr` fact for each one read. When `gh` fails for some, the others are still
/// appended, and the error names each failed PR.
pub fn refresh_prs(
    store: &Store,
    slice: Option<&TicketId>,
    effects: &PrEffects,
) -> Result<Vec<RefreshedPr>, StoreError> {
    let root = store.root();
    let targets = {
        let _lock = (effects.lock_store)(root, LockAccess::Shared)?;

        refresh_targets(root, slice)?
    };
    let mut observed = Vec::new();
    let mut failures = Vec::new();

    for (slice, pull_request) in targets {
        match read_pull_request(effects.run_gh, &pull_request) {
            Ok(observation) => observed.push((slice, observation)),
            Err(message) => failures.push(PrFailure {
                slice,
                pull_request,
                message,
            }),
        }
    }

    let refreshed = append_observed(root, observed, effects)?;

    if !failures.is_empty() {
        return Err(StoreError::Gh { failures });
    }

    Ok(refreshed)
}

// The caller holds the store lock.
fn refresh_targets(
    root: &Path,
    slice: Option<&TicketId>,
) -> Result<Vec<(TicketId, PullRequest)>, StoreError> {
    let scan = read_tickets(root)?;
    let mut prs = current_prs(&read_facts(root)?.facts);

    if let Some(slice) = slice {
        check_linkable(&scan, slice)?;

        let shown = prs.remove(slice).ok_or_else(|| StoreError::NotLinked {
            id: slice.to_string(),
        })?;

        return Ok(vec![(slice.clone(), shown.observation.pull_request)]);
    }

    let index = TicketIndex::new(&scan);
    let mut targets: Vec<(TicketId, PullRequest)> = prs
        .into_iter()
        .filter(|(id, shown)| !shown.observation.in_trunk && is_slice(&index, id))
        .map(|(id, shown)| (id, shown.observation.pull_request))
        .collect();

    targets.sort();

    Ok(targets)
}

// A slice whose ticket is gone, broken, or shared gets no fact, and one linked to another PR
// since the read keeps that link.
fn append_observed(
    root: &Path,
    observed: Vec<(TicketId, PrObservation)>,
    effects: &PrEffects,
) -> Result<Vec<RefreshedPr>, StoreError> {
    if observed.is_empty() {
        return Ok(Vec::new());
    }

    let _lock = (effects.lock_store)(root, LockAccess::Exclusive)?;
    let scan = read_tickets(root)?;
    let index = TicketIndex::new(&scan);
    let current = current_prs(&read_facts(root)?.facts);
    let mut refreshed = Vec::new();

    for (slice, observation) in observed {
        if !still_linked(&index, &current, &slice, &observation.pull_request) {
            continue;
        }

        let pr = append_pr(root, &slice, observation, &effects.lease)?;

        refreshed.push(RefreshedPr { slice, pr });
    }

    Ok(refreshed)
}

fn still_linked(
    index: &TicketIndex<'_>,
    current: &HashMap<TicketId, ShownPr>,
    slice: &TicketId,
    pull_request: &PullRequest,
) -> bool {
    let linked = current
        .get(slice)
        .is_some_and(|shown| shown.observation.pull_request == *pull_request);

    linked && is_slice(index, slice)
}

fn is_slice(index: &TicketIndex<'_>, id: &TicketId) -> bool {
    matches!(index.look_up(id), TicketLookup::Found(ticket) if ticket.document.fields.kind() == Kind::Slice)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::fs;
    use std::path::PathBuf;

    use tempfile::TempDir;

    use super::refresh_prs;
    use crate::fact::{FactEvent, FactLine, PrObservation, PrState, PullRequest, Timestamp};
    use crate::store::fact_files::{append_fact, append_line, read_facts};
    use crate::store::pr_link::PrEffects;
    use crate::store::{MachineName, Store, StoreEffects, StoreError, init};
    use crate::ticket::TicketId;

    const PLAN: &str = "---\nkind: plan\ntitle: Plan\n---\n";
    const SLICE: &str = "---\nkind: slice\ntitle: Slice\nparent: personal-pppp\ncriteria:\n  - id: s1\n    check: c\n    expected: e\n---\n";
    const MERGED: &str = "{\"number\":7,\"state\":\"MERGED\",\"baseRefName\":\"main\",\"headRefOid\":\"head\",\"mergeCommit\":{\"oid\":\"merge\"}}";
    const TRUNK: &str = "{\"defaultBranchRef\":{\"name\":\"main\"}}";

    const OPEN: &str = "{\"number\":7,\"state\":\"OPEN\",\"baseRefName\":\"main\",\"headRefOid\":\"new-head\",\"mergeCommit\":null}";

    thread_local! {
        static ROOT: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
        static CALLS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    }

    fn open_gh(arguments: &[&str]) -> Result<Vec<u8>, String> {
        CALLS.with(|calls| calls.borrow_mut().push(arguments.join(" ")));

        Ok(OPEN.as_bytes().to_vec())
    }

    fn open_effects() -> PrEffects {
        PrEffects {
            run_gh: open_gh,
            ..PrEffects::system()
        }
    }

    fn link_ticket(root: &std::path::Path, ticket: &str, observation: PrObservation) {
        let fact = FactLine {
            ticket: id(ticket),
            at: Timestamp::parse("2026-11-13T01:00:00Z").expect("a valid time"),
            event: FactEvent::Pr(observation),
        };

        append_fact(root, &fact, append_line).expect("append the PR fact");
    }

    fn id(text: &str) -> TicketId {
        TicketId::parse(text).expect("a valid ID")
    }

    fn observation(number: u64) -> PrObservation {
        PrObservation {
            pull_request: PullRequest::new("owner/app", number).expect("a valid PR"),
            state: PrState::Open,
            base: "main".to_owned(),
            head: "head".to_owned(),
            merge_commit: None,
            in_trunk: false,
        }
    }

    fn link(root: &std::path::Path, number: u64, at: &str) {
        let fact = FactLine {
            ticket: id("personal-kkkk"),
            at: Timestamp::parse(at).expect("a valid time"),
            event: FactEvent::Pr(observation(number)),
        };

        append_fact(root, &fact, append_line).expect("append the PR fact");
    }

    // Another process links PR 8 while gh reads PR 7.
    fn relinking_gh(arguments: &[&str]) -> Result<Vec<u8>, String> {
        let root = ROOT
            .with(|root| root.borrow().clone())
            .expect("the store is set");

        if arguments[0] == "pr" {
            link(&root, 8, "2026-11-13T02:00:00Z");

            return Ok(MERGED.as_bytes().to_vec());
        }

        Ok(TRUNK.as_bytes().to_vec())
    }

    fn store_with_slice() -> (TempDir, Store) {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let machine = MachineName::parse("test").expect("a valid machine name");
        init(directory.path(), Some(machine), &StoreEffects::system()).expect("init the store");
        let folder = directory.path().join("tickets/personal");
        fs::create_dir_all(&folder).expect("create the project folder");
        fs::write(folder.join("personal-pppp-plan.md"), PLAN).expect("write the plan");
        fs::write(folder.join("personal-kkkk-slice.md"), SLICE).expect("write the slice");

        let store = Store {
            root: directory.path().to_path_buf(),
        };

        (directory, store)
    }

    #[test]
    fn refresh_appends_and_returns_the_state_gh_read_for_a_linked_slice() {
        let (directory, store) = store_with_slice();
        link(directory.path(), 7, "2026-11-13T01:00:00Z");

        let refreshed = refresh_prs(&store, None, &open_effects()).expect("the refresh runs");

        let facts = read_facts(store.root()).expect("read the facts").facts;
        assert_eq!(CALLS.with(|calls| calls.take()).len(), 1);
        assert_eq!(refreshed.len(), 1);
        assert_eq!(refreshed[0].slice, id("personal-kkkk"));
        assert_eq!(refreshed[0].pr.observation.head, "new-head");
        assert_eq!(facts.len(), 2);
        assert!(
            matches!(&facts[1].event, FactEvent::Pr(observation) if observation.head == "new-head")
        );
    }

    #[test]
    fn refresh_of_all_skips_a_pr_in_trunk_and_a_pr_fact_on_a_ticket_that_is_not_a_slice() {
        let (directory, store) = store_with_slice();
        let in_trunk = PrObservation {
            state: PrState::Merged,
            merge_commit: Some("merge".to_owned()),
            in_trunk: true,
            ..observation(7)
        };
        link_ticket(directory.path(), "personal-kkkk", in_trunk);
        // Invalid data: `pr link` takes only slices, so this fact is written by hand.
        link_ticket(directory.path(), "personal-pppp", observation(8));

        let refreshed = refresh_prs(&store, None, &open_effects()).expect("the refresh runs");

        let facts = read_facts(store.root()).expect("read the facts").facts;
        assert_eq!(CALLS.with(|calls| calls.take()), Vec::<String>::new());
        assert_eq!(refreshed, Vec::new());
        assert_eq!(facts.len(), 2);
    }

    #[test]
    fn refresh_of_a_slice_without_a_pr_is_refused() {
        let (_directory, store) = store_with_slice();

        let error = refresh_prs(&store, Some(&id("personal-kkkk")), &PrEffects::system())
            .expect_err("the slice has no PR");

        assert!(
            matches!(&error, StoreError::NotLinked { id } if id == "personal-kkkk"),
            "{error:?}"
        );
    }

    #[test]
    fn a_pr_linked_again_while_gh_reads_the_old_one_keeps_the_new_link() {
        let (directory, store) = store_with_slice();
        link(directory.path(), 7, "2026-11-13T01:00:00Z");
        ROOT.with(|root| root.replace(Some(directory.path().to_path_buf())));
        let effects = PrEffects {
            run_gh: relinking_gh,
            ..PrEffects::system()
        };

        let refreshed = refresh_prs(&store, None, &effects).expect("the refresh runs");

        let facts = read_facts(store.root()).expect("read the facts").facts;
        assert_eq!(refreshed, Vec::new());
        assert_eq!(facts.len(), 2);
    }
}
