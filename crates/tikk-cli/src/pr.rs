use serde_json::{Value, json};
use tikk_core::{
    Identity, PrEffects, PullRequest, RefreshedPr, ShownPr, StackParent, Store, StoreError,
    TicketId,
};

use crate::output::Output;

pub(crate) fn run_link(
    store: &Store,
    id: &TicketId,
    pull_request: &PullRequest,
    caller: &Identity,
    effects: &PrEffects,
) -> Result<Output, StoreError> {
    let shown = tikk_core::link_pr(store, id, pull_request, caller, effects)?;

    Ok(Output {
        json: json!({ "id": id.to_string(), "pr": pr_json(&shown) }),
        text: format!("{id}  {}", pr_text(&shown)),
    })
}

pub(crate) fn run_refresh(
    store: &Store,
    id: Option<&TicketId>,
    effects: &PrEffects,
) -> Result<Output, StoreError> {
    let outcome = tikk_core::refresh_prs(store, id, effects)?;
    let rows: Vec<Value> = outcome
        .refreshed
        .iter()
        .map(|refreshed| json!({ "id": refreshed.slice.to_string(), "pr": pr_json(&refreshed.pr) }))
        .collect();
    let mut text = refreshed_text(&outcome.refreshed);

    for slice in &outcome.audit_behind {
        text.push_str(&format!(
            "\n{slice}  auditBehind: the PR head differs from the last audit"
        ));
    }

    Ok(Output {
        json: json!({ "refreshed": rows, "auditBehind": outcome.audit_behind }),
        text,
    })
}

pub(crate) fn pr_json(shown: &ShownPr) -> Value {
    let observation = &shown.observation;

    json!({
        "repository": observation.pull_request.repository(),
        "number": observation.pull_request.number(),
        "url": observation.pull_request.url(),
        "state": observation.state.as_str(),
        "base": observation.base,
        "head": observation.head,
        "mergeCommit": observation.merge_commit,
        "inTrunk": observation.in_trunk,
        "prCheckedAt": shown.checked_at.to_string(),
    })
}

pub(crate) fn pr_text(shown: &ShownPr) -> String {
    let observation = &shown.observation;
    let trunk = if observation.in_trunk {
        " in trunk"
    } else {
        ""
    };

    format!(
        "{} {}{trunk} at {}, checked {}",
        observation.pull_request.url(),
        observation.state.as_str(),
        observation.head,
        shown.checked_at
    )
}

pub(crate) fn stack_parent_json(parent: &StackParent) -> Value {
    let observation = &parent.pr.observation;

    json!({
        "slice": parent.slice.to_string(),
        "repository": observation.pull_request.repository(),
        "number": observation.pull_request.number(),
        "url": observation.pull_request.url(),
        "head": observation.head,
        "prCheckedAt": parent.pr.checked_at.to_string(),
    })
}

pub(crate) fn stack_parent_text(parent: &StackParent) -> String {
    let observation = &parent.pr.observation;

    format!(
        "stacks on {} of {} at {}, checked {}",
        observation.pull_request.url(),
        parent.slice,
        observation.head,
        parent.pr.checked_at
    )
}

fn refreshed_text(refreshed: &[RefreshedPr]) -> String {
    if refreshed.is_empty() {
        return "No PR to refresh.".to_owned();
    }

    refreshed
        .iter()
        .map(|refreshed| format!("{}  {}", refreshed.slice, pr_text(&refreshed.pr)))
        .collect::<Vec<_>>()
        .join("\n")
}
