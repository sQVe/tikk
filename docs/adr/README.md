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
- [0002: Own repository on the shared project base](./0002-shared-project-base-and-stack.md)
- [0003: One Git store per user with one lock](./0003-one-git-store-with-one-lock.md)
- [0004: Ticket intent in Markdown files](./0004-intent-in-markdown-files.md)
- [0005: Observed facts in per-machine JSONL](./0005-facts-in-per-machine-jsonl.md)
- [0006: A disposable SQLite cache](./0006-disposable-sqlite-cache.md)
- [0007: Plans, slices, tasks, and issues](./0007-work-model-and-kinds.md)
- [0008: Short random IDs and stable file names](./0008-ids-and-file-names.md)
- [0009: A slice is done when its PR merged and its criteria are met](./0009-derived-slice-done.md)
- [0010: Archive is a field](./0010-archive-as-a-field.md)
- [0011: `tikk needs` holds the attention query](./0011-needs-holds-the-attention-query.md)
