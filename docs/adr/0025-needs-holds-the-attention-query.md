# ADR 0025: `tikk needs` holds the attention query in the shared core

**Date**: 2026-11-04\
**Status**: Accepted\
**Related**: [ADR 0033 (Every command reads the store files, with no cache)](./0033-files-only-store-without-a-cache.md),
[ADR 0010 (The CLI contract for agents)](./0010-cli-contract-for-agents.md)

## Context

The user cannot see in one place what needs them. The desktop app should open on that view. Agents
and scripts need the same list.

## Decision

The attention query lives in the shared core crate, as a pure function in its `fact` module over
values the store reads. `tikk needs` and `tikk needs --json` return it, and the desktop app's
attention view shows it. The desktop app opens on that view, and it is a thin
view over the query. It does no attention logic of its own. It can act on a listed item, such as
closing or accepting it, through the same core code as the CLI command. `e` opens a ticket in
`$EDITOR`, and the desktop app edits no ticket text.

### Attention reasons

The "needs you" view lists only what is on the user. Each item comes from `tikk needs --json` and
has one reason. Items are ordered by reason in this order, then by ticket ID, then by item:

- `question`: an open question on a ticket of any status, with its item ID and text. It shows at
  once, with no pass-up step and no waiting time, until an answer names its item.
- `staleClaim`: a claim whose lease ended, with its holder and lease end, on a ticket that is not
  done or canceled.
- `blockingTask`: an open task that a ticket which is not done or canceled lists in its own
  `blockedBy`, with the tickets it blocks. Plans and slices count as done by their derived state
  ([ADR 0023](./0023-derived-slice-done.md)). Only direct edges count, and a task whose ID is in
  more than one file is not listed.
- `looseTask`: an open task with no parent.
- `mergedUnverified`: a slice whose derived state is `mergedUnverified`, with its PR and
  `prCheckedAt`. `tikk needs` reads the `pr` facts and never runs `gh`, so a merge shows after the
  next `tikk pr refresh`.

An age from a `status` fact is not a reason, and there is no `newTask`, `submitted`, or `flagged`
reason. The reasons `draftPlan` and `blockedFinding` wait for a later design of the commands that
would set them.

### Questions

`tikk ask <id> --text <text>` appends a `question` fact with the ticket ID, a new item ID, and the
text ([ADR 0015](./0015-facts-in-per-machine-jsonl.md)). The item ID is drawn like the suffix of a
ticket ID, and it is unique among the ticket's questions. `tikk answer <id> <item> --text <text>`
appends an `answer` fact with the same three values. A later answer to an item replaces an earlier
one. `tikk show --json` of a ticket returns its questions with their answers, so an agent reads
the answer there, also after a restart. An agent's `ask` follows the claim rules of other writes to
a slice's work ([ADR 0022](./0022-claims-leases-and-ready-queue.md)). The user answers, so no claim
refuses an `answer`, and an answer renews no lease.

### Problems

`tikk needs` also lists `problems`, each with a `code`: ticket files that do not parse
(`parseError`), IDs in more than one file (`idShared`), fact lines that do not parse
(`factUnreadable`), and the last sync, read from its saved result, when it stopped (`syncFailed`)
or reported a problem (`syncProblem`), with the files it names. A saved result that cannot be read
is `syncResultUnreadable`. Each problem keeps the path fields that `tikk ls` and `tikk sync` use.
A ticket file that cannot be read at all still fails the command, as it fails `tikk ls`.

## Consequences

### Positive

- The desktop view and agents read the same list from one query.
- A new reason is added in one place, and both clients show it.

### Negative

- The desktop app cannot show anything the query does not return.
- A store with no remote lists the fetch problem of its last sync, claim, or release, because
  that sync reports it.
- A merge shows only after a `tikk pr refresh`, because `tikk needs` runs no `gh`.

## Alternatives considered

### The desktop app computes attention itself

Let the view query the cache directly. Rejected because the design wants one attention query that
agents read through `tikk needs --json` and the view only shows. Two copies of the logic could list
different items.

### Questions pass up after a delay

Show a question only after a manager passes it up with `tikk pass-up`, or after 30 minutes.
Rejected because the user then sees a question late, and the delay needs a clock rule and a pass-up
command that add nothing an agent cannot do by asking later.

### Editing ticket text inside the desktop app

Edit titles, bodies, or criteria in the desktop app. Rejected because the user edits ticket files in
a text editor. Actions that change state, such as close or accept, stay in the desktop app because
they are one action and have a CLI equal.
