# ADR 0023: A slice is done when its PR merged and its criteria are met

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0015 (Observed facts in per-machine JSONL)](./0015-facts-in-per-machine-jsonl.md)

## Context

A merged PR does not prove that the slice met its criteria. Done must be robust, and unfinished work
must never close silently.

## Decision

A slice is done when its PR merged into trunk and its criteria are met for the merged head. Done is
derived from facts and is never written to the file. A slice whose PR merged with no current audit
shows as merged but unverified.

Open instructions and open tasks at merge stay open. A slice whose PR merged into trunk with a
passing audit is `flagged`, not done, while it has an open instruction or an open task. An
instruction counts until it is accepted or canceled with a reason. A task counts while its status is
`open`. Archived instructions and tasks count too, because archive hides a ticket but does not
complete it. A flagged slice does not clear the tickets it blocks.

A plan's completion is derived the same way. An open plan is done when it has at least one slice or
task that is not canceled, every slice that is not canceled is done, and every direct task is done
or canceled. A draft or canceled plan keeps its stored status. A done plan clears the tickets it
blocks.

Only `tikk pr link` and `tikk pr refresh` run `gh`, and each read appends a `pr` fact
([ADR 0015](./0015-facts-in-per-machine-jsonl.md)). `pr link <slice> <url>` reads the PR and makes
it the slice's PR. `pr refresh` reads every linked PR that tikk has not yet seen in trunk, closed
ones included, so a merge is never missed. `pr refresh <slice>` reads that slice's PR, even when it
is in trunk. When `gh` fails for some PRs, `pr refresh` still appends the facts it read, then exits
with 1 and the code `ghError`, and names each PR it could not read. `ready`, `show`, and `needs`
read the `pr` facts and never use the network.

A PR merged into the trunk branch is in trunk. A PR merged into another branch counts only once
trunk holds its merge commit. A slice's PR is the one its newest `pr` fact names. Among that PR's
facts, one that saw the PR in trunk wins, then one with a merge commit, then the newest. Each
output that shows a PR state shows `prCheckedAt` beside it, the time of the newest `pr` fact of
that PR, so the caller can tell how old the state is. There is no `unknown` state: a failed read
leaves the last recorded state in place.

`tikk audit <slice> --hash <hash> --repository <owner/name> --head <sha> --base <sha> --change-hash
<hash> --verdicts-file <path>` records one verdict for each criterion of the slice. The audit
refuses a ticket changed since the given hash. An audit counts only when its repository and head
match the PR at merge, and it has a `met` verdict for every current criterion. A verdict counts only
for the criterion's current `check` and `expected` text, so an edit to either text voids it until a
new audit runs.

## Consequences

### Positive

- Done means merged and verified against the merged code.
- Open instructions and tasks never disappear at merge, and a plan is not done while work under it
  is open.

### Negative

- Derived done depends on fresh `gh` facts. A slice reads as open until a `tikk pr refresh`
  records its merge.
- A slice sits as merged but unverified until an audit runs.

## Alternatives considered

### Merge alone means done

Mark the slice done when the PR merges. Rejected because done must be robust, and a merge does not
show that the criteria are met.

### Close open instructions at merge

End unfinished instructions when the slice merges. Rejected because unfinished instructions never
close silently.

### Read PR states through `gh` on each query

Run `gh` from `ready`, `show`, and `needs` before they answer. Rejected because each query would
wait on the network, fail offline, and spend GitHub rate limit on every call. Two explicit commands
keep queries local, and `prCheckedAt` shows the caller how old each state is.
