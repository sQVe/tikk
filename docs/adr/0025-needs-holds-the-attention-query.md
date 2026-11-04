# ADR 0025: `tikk needs` holds the attention query in the shared core

**Date**: 2026-11-04\
**Status**: Accepted\
**Related**: [ADR 0017 (A disposable SQLite cache)](./0017-disposable-sqlite-cache.md),
[ADR 0010 (The CLI contract for agents)](./0010-cli-contract-for-agents.md)

## Context

The user cannot see in one place what needs them. The desktop app should open on that view. Agents
and scripts need the same list.

## Decision

The attention query lives in the shared core crate. `tikk needs` and `tikk needs --json` return it,
and the desktop app's attention view shows it. The desktop app opens on that view, and it is a thin
view over the query. It does no attention logic of its own. It can act on a listed item, such as
closing or accepting it, through the same core code as the CLI command. `e` opens a ticket in
`$EDITOR`, and the desktop app edits no ticket text.

### Attention reasons

The "needs you" view lists only what is on the user. Each item comes from `tikk needs --json` and
has one reason:

- `question`: an open question that the manager passed up with `tikk pass-up`, or that is 30 minutes
  old with no pass-up. The item carries the question text.
- `submitted`: the latest submission, once the manager passed it up.
- `staleClaim`: a claim whose lease ended.
- `blockingTask`: an open task that an unfinished ticket lists in `blockedBy`.
- `newTask`: a loose open task that `tikk new --json` created and that a later move, rank, done, or
  cancel has not cleared.
- `draftPlan`: a draft plan whose latest `waiting` fact is true. `tikk wait <id> --text <text>` sets
  it, and `tikk wait <id> --done` clears it.
- `flagged`: a merged slice with open instructions or tasks under it.
- `mergedUnverified`: a merged slice with no current audit that meets every criterion.
- `blockedFinding`: a review finding whose latest status is blocked.

Questions, submissions, answers, acceptances, rejections, and pass-ups each name an item ID, so the
reader can tell which item an action decides. A task has no create time, so its age comes from its
latest status fact. A task with no status fact has no age.

## Consequences

### Positive

- The desktop view and agents read the same list from one query.
- A new reason is added in one place, and both clients show it.

### Negative

- The desktop app cannot show anything the query does not return.

## Alternatives considered

### The desktop app computes attention itself

Let the view query the cache directly. Rejected because the design wants one attention query that
agents read through `tikk needs --json` and the view only shows. Two copies of the logic could list
different items.

### Editing ticket text inside the desktop app

Edit titles, bodies, or criteria in the desktop app. Rejected because the user edits ticket files in
a text editor. Actions that change state, such as close or accept, stay in the desktop app because
they are one action and have a CLI equal.
