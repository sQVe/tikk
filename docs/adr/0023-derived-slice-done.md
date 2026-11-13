# ADR 0023: A slice is done when its PR merged and its criteria are met

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0015 (Observed facts in per-machine JSONL)](./0015-facts-in-per-machine-jsonl.md)

## Context

A merged PR does not prove that the slice met its criteria. Done must be robust, and unfinished work
must never close silently.

## Decision

A slice is done when its PR merged into trunk and its last audit counts. Done is derived from the
ticket files and the facts, and is never written to a file. The stored `status` stays as written, and
`tikk done` still refuses a plan or a slice. Only an open plan or slice derives a state; a draft or
canceled one keeps its stored status.

An open slice derives one of these states, with no `flagged` and no `unknown` state:

- `done`: its PR is in trunk and its last audit counts.
- `mergedUnverified`: its PR is in trunk, and it has no audit or its last audit does not count.
- `auditBehind`: its PR is open, and its last audit saw another head. The manager audits again
  before the merge, while it still holds the slice.
- `open`: any other case.

An open instruction holds nothing back, because the audit already judges every criterion of the
slice.

A plan's completion is derived from its children. An open plan is done when it has at least one
slice or task that is not canceled, every slice that is not canceled is done, and every direct task
is done or canceled. A canceled child never counts. A done slice or plan clears the tickets it
blocks in `tikk ready`, by direct and by inherited edges, and a done slice is no longer listed
there. A `mergedUnverified` slice is skipped with that hold and does not clear the tickets it blocks.
A slice whose ID two files share derives nothing, because tikk cannot tell which file a fact
belongs to.

Done fails closed on input that tikk cannot read. While any fact line does not parse, no slice
derives `done`: a slice that would be done reads `mergedUnverified`, because the unreadable line may
be a newer audit of it. Plans then cannot be done either. While any ticket file does not parse or
cannot be read, no plan derives `done` and each open plan reads `open`, because the file may be an
unfinished child. Slices are unaffected by unreadable ticket files, and the other derived states
are unchanged. `show`, `ls`, `ready`, and `pr refresh` share this one derivation.

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

`tikk audit <slice> --hash <hash> --head <sha> --file <path> [--repository <owner/name>]` appends
an `audit` fact with a verdict for criteria of the slice. The repository is the GitHub repository of
the working directory's `origin` unless `--repository` names one. The audit refuses a ticket changed
since the given hash with `changedOnDisk`, and checks the hash and appends the fact in one hold of
the store lock. It runs the strict checks of a claim except the open-only rule
([ADR 0021](./0021-validation-levels.md)), so an audit after the merge works. It refuses another
agent's live claim with `claimed`, renews the holder's lease ([ADR
0022](./0022-claims-leases-and-ready-queue.md)), and runs no `gh` and no sync.

A slice's last audit is its newest `audit` fact. It counts only when its repository and head match
the PR state that the rules above select, with owner and name compared without letter case as
GitHub does, the slice still has at least one criterion, every current criterion has a `met` verdict, and each
criterion's `check` and `expected` text is the text the audit saw. An edit to either text voids the
verdict until a new audit runs. `tikk show` lists each reason the last audit does not count:
`headDiffers`, `repositoryDiffers`, `criterionChanged`, `criterionMissing`, or `notMet`, with the
criterion where one applies, `noCriteria` when the slice has no criterion left, and `notLinked`
when the slice has no PR. `tikk pr refresh` lists the
refreshed slices that are `auditBehind`.

## Consequences

### Positive

- Done means merged and verified against the merged code.
- A plan is not done while a slice or a task under it is open.
- A broken fact line or ticket file never makes a slice or a plan read done.
- An audit made before the merge still counts for the merged code when the PR head did not move.

### Negative

- Derived done depends on fresh `gh` facts. A slice reads as open until a `tikk pr refresh`
  records its merge.
- A slice sits as merged but unverified until an audit runs.
- An instruction left open under a done slice stays open until someone closes or cancels it.
- One broken fact line holds back done for every slice in the store, and one broken ticket file
  holds back done for every plan, until someone fixes or removes it.

## Alternatives considered

### Merge alone means done

Mark the slice done when the PR merges. Rejected because done must be robust, and a merge does not
show that the criteria are met.

### Close open instructions at merge

End unfinished instructions when the slice merges. Rejected because unfinished instructions never
close silently.

### A `flagged` state while an instruction is open

Keep a slice that merged with a counting audit as `flagged`, not done, while it has an open
instruction. Rejected because the audit already judges every criterion, so an open instruction adds
no check, and a flagged slice would hold back the tickets it blocks.

### Read PR states through `gh` on each query

Run `gh` from `ready`, `show`, and `needs` before they answer. Rejected because each query would
wait on the network, fail offline, and spend GitHub rate limit on every call. Two explicit commands
keep queries local, and `prCheckedAt` shows the caller how old each state is.
