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

PR facts come from `tikk reconcile`. It runs on `ready` and `needs`, and after `tikk pr link`. It
checks every linked PR that tikk has not yet seen merged into trunk, closed ones included, so a
merge is never missed. A PR merged into another branch counts only once its work reaches trunk. A
`pr` fact with a merge commit wins over one without, and one that saw the merge in trunk wins over
both. Each derived state shows the age of its oldest input. Items with stale facts stay out of
"needs you" and show as unknown.

`tikk audit <slice> --repository <owner/name> --head <sha> --base <sha> --change-hash <hash> --verdicts-file <path>`
records one verdict for each criterion of the slice. An audit counts only when its repository and
head match the PR at merge, and it has a `met` verdict for every current criterion.

## Consequences

### Positive

- Done means merged and verified against the merged code.
- Open instructions and tasks never disappear at merge, and a plan is not done while work under it
  is open.

### Negative

- Derived done depends on fresh `gh` facts. A stale cache can show a slice open.
- A slice sits as merged but unverified until an audit runs.

## Alternatives considered

### Merge alone means done

Mark the slice done when the PR merges. Rejected because done must be robust, and a merge does not
show that the criteria are met.

### Close open instructions at merge

End unfinished instructions when the slice merges. Rejected because unfinished instructions never
close silently.
