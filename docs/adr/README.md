# Architecture decision records

Record lasting decisions and the reasons behind them, not how a feature works.

## Before writing

Follow [ADR 0001](./0001-documentation-scope.md) for documentation scope. Before opening the
[template](./TEMPLATE.md), answer:

- What choice are we making, and what lasting reason stands behind it?
- What credible alternative did we consider, and why did we reject it?

If the answers only restate what the code does, do not write an ADR. Code and tests hold behavior. A
feature change does not require a new document.

Use a title that names the choice, and state that choice in the first sentence of the Decision
section. Give each rejected or deferred alternative its own heading under Alternatives considered.
An ADR is not a feature summary, implementation plan, or acceptance checklist.

A new ADR is Accepted. Merging its PR is the approval, so there is no Proposed stage. When a later
decision replaces it, keep its reasoning, change its status to Superseded, and add a Superseded by
line that links to the replacement.

## Index

- [0001: Documentation scope](./0001-documentation-scope.md)
- [0002: Own repository on the shared project base](./0002-shared-project-base.md)
- [0003: Bun as runtime, package manager, test runner, and compiler](./0003-bun-toolchain.md)
- [0004: OpenTUI with React for the TUI](./0004-opentui-react-tui.md)
- [0005: Results for expected failures, exceptions for bugs, and zod at boundaries](./0005-results-exceptions-and-zod-boundaries.md)
- [0006: Capability modules with an enforced import table](./0006-capability-modules.md)
- [0007: Side effects as narrow function records](./0007-side-effect-function-records.md)
- [0008: One owner for terminal lifetime](./0008-terminal-lifetime-owner.md)
- [0009: Owner files inside modules, thin coordinators, and owner-first file names](./0009-owner-files-and-file-names.md)
- [0010: The CLI contract for agents](./0010-cli-contract.md)
- [0011: One user, with no ownership, permissions, or assignees](./0011-single-user.md)
- [0012: One Git store per user with one lock](./0012-one-git-store-with-one-lock.md)
- [0013: Ticket intent in Markdown files](./0013-intent-in-markdown-files.md)
- [0014: Git history is undo, with no event sourcing for intent](./0014-git-history-as-undo.md)
- [0015: Observed facts in per-machine JSONL](./0015-facts-in-per-machine-jsonl.md)
- [0016: Evidence records bound to code state, finding status from triage, and coverage as a query](./0016-evidence-records-and-criteria-coverage.md)
- [0017: A disposable SQLite cache](./0017-disposable-sqlite-cache.md)
- [0018: Plans, slices, tasks, and issues](./0018-work-model-and-kinds.md)
- [0019: Short random IDs and stable file names](./0019-ids-and-file-names.md)
- [0020: Edges are `blockedBy`, `discoveredFrom`, and `related`](./0020-edges.md)
- [0021: Strict validation at claim, submit, and close](./0021-validation-levels.md)
- [0022: Claims with leases and a ready queue that names what it skipped](./0022-claims-leases-and-ready-queue.md)
- [0023: A slice is done when its PR merged and its criteria are met](./0023-derived-slice-done.md)
- [0024: Archive is a field](./0024-archive-as-a-field.md)
- [0025: `tikk needs` holds the attention query](./0025-needs-holds-the-attention-query.md)
