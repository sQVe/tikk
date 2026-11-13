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

A new ADR is Accepted. Merging its PR is the approval, so there is no Proposed stage.

## Keeping ADRs current

An ADR states the current decision. When its details change, edit it in place. Supersede it only
when the core choice reverses. The new ADR then states the whole current rule and has a Supersedes
line that names the old ADR without a link. Delete the old file, and add a row for it to the Retired
table. Numbers are never reused. To read a retired ADR, run `git show <commit>:docs/adr/<file>` with
the commit in its row.

## Index

### Documentation

- [0001: Documentation scope](./0001-documentation-scope.md)

### Platform and project

- [0002: Native Rust app with GPUI, as two binaries over one core crate](./0002-native-rust-gpui-two-binaries.md)
- [0003: Vendored gpui-component with a recorded patch boundary](./0003-vendored-gpui-component.md)
- [0004: Toolchain, dependencies, and quality gates](./0004-toolchain-and-quality-gates.md)
- [0029: tikk supports Linux and macOS, not Windows](./0029-linux-and-macos-only.md)
- [0031: Dev builds keep line tables only, and dependencies keep no debug info](./0031-dev-builds-keep-line-tables-only.md)

### Code structure

- [0005: Typed results for expected failures, panics for bugs, and parse-once boundaries](./0005-results-panics-and-parse-once-boundaries.md)
- [0006: Capability modules with an enforced dependency table](./0006-capability-modules.md)
- [0007: Side effects as narrow records of functions](./0007-side-effect-function-records.md)
- [0008: One owner for the desktop app's lifetime](./0008-app-lifetime-owner.md)
- [0009: Owner files inside modules, thin coordinators, and owner-first file names](./0009-owner-files-and-file-names.md)
- [0030: A Rust coding guide adapts Tau's coding rules](./0030-rust-coding-guide.md)

### Agent interface

- [0010: The CLI for agents is non-interactive and matches the desktop app](./0010-cli-contract-for-agents.md)

### Domain and storage

- [0011: One user, with no ownership, permissions, or assignees](./0011-single-user.md)
- [0012: One Git store per user with one lock](./0012-one-git-store-with-one-lock.md)
- [0013: Ticket intent in Markdown files](./0013-intent-in-markdown-files.md)
- [0014: Git history is undo, with no event sourcing for intent](./0014-git-history-as-undo.md)
- [0015: Observed facts in per-machine JSONL](./0015-facts-in-per-machine-jsonl.md)
- [0016: Evidence bound to code state, triage status, and coverage as a query](./0016-evidence-records-and-criteria-coverage.md)
- [0018: Plans, slices, instructions, and tasks](./0018-work-model-and-kinds.md)
- [0019: Short random IDs and stable file names](./0019-ids-and-file-names.md)
- [0020: Edges are `blockedBy`, `discoveredFrom`, and `related`](./0020-edges.md)
- [0021: Strict validation at claim and audit](./0021-validation-levels.md)
- [0022: Claims with leases and a ready queue that names what it skipped](./0022-claims-leases-and-ready-queue.md)
- [0023: A slice is done when its PR merged and its criteria are met](./0023-derived-slice-done.md)
- [0024: Archive is a field](./0024-archive-as-a-field.md)
- [0033: Every command reads the store files, with no cache](./0033-files-only-store-without-a-cache.md)

### Clients

- [0025: `tikk needs` holds the attention query in the shared core](./0025-needs-holds-the-attention-query.md)
- [0026: Classifier advice comes from clients and never blocks](./0026-classifier-advice-from-clients.md)

### Quality

- [0027: Advisory mutation testing of changed lines with cargo-mutants](./0027-advisory-mutation-testing.md)
- [0028: Two AI judges from different model families gate UI mocks](./0028-two-family-ui-mock-gate.md)
- [0032: QA in the ruta sandbox](./0032-qa-in-the-ruta-sandbox.md)

## Earlier numbering

This table maps the numbers of the earlier ADR set to the current numbers. Use it only to find where
an old decision went. The ADRs themselves do not use the old numbers.

| Old | New | Reason |
| --- | --- | ------ |
| 0001 | 0001 | Replaced by the new documentation scope ADR, which covers it. |
| 0002 | Merged into 0002 | Independence from the agent client stays. The shared base is dropped. |
| 0003 | Merged into 0004 and 0002 | Bun and its test runner are dropped, and Cargo replaces them. SQLite is kept in 0017, and native binaries with no runtime to install are kept in 0002. |
| 0004 | Merged into 0002, 0010, and 0025 | The native app replaces the terminal UI. Shared actions and external editing move to 0010, and the attention-first view moves to 0025. |
| 0005 | 0005 | Rewritten for Rust errors, panics, and serde decoding. |
| 0006 | 0006 | Rewritten for Rust modules and an `xtask` dependency table. |
| 0007 | 0007 | Rewritten for Rust function records and process argument lists. |
| 0008 | 0008 | Rewritten for the desktop app's lifetime. The terminal lending rules are dropped. |
| 0009 | 0009 | Rewritten for snake_case Rust file names. |
| 0010 | 0010 | Kept, with the desktop app in place of the terminal UI and `$EDITOR` in place of the edit key. |
| 0011 | 0011 | Kept as written. |
| 0012 | 0012 | Kept; sync runs through the core crate instead of a JavaScript child process. |
| 0013 | 0013 | Kept; front matter is decoded in Rust. |
| 0014 | 0014 | Kept as written. |
| 0015 | 0015 | Kept as written. |
| 0016 | 0016 | Kept as written. |
| 0017 | 0017 | Kept; the cache uses a Rust SQLite binding and the desktop app's watcher. |
| 0018 | 0018 | Kept as written. |
| 0019 | 0019 | Kept; the alphabet is written out, and IDs are generated in Rust. |
| 0020 | 0020 | Kept; the stacking exception is stated. |
| 0021 | 0021 | Kept; "never blocked" is limited to validation gates, and `--force` is limited to them too. |
| 0022 | 0022 | Kept as written. |
| 0023 | 0023 | Kept as written. |
| 0024 | 0024 | Kept; the desktop views replace the terminal views. |
| 0025 | 0025 | Rewritten: the query lives in the shared core, and the desktop app opens on it. |
| 0026 | 0026 | Kept; the CLI is the transport. |
| 0027 | 0027 | Rewritten for cargo-mutants through `cargo xtask mutation`. |

## Retired

| ADR | Title | Replaced by | Last commit |
| --- | ----- | ----------- | ----------- |
| 0017 | A disposable SQLite cache | [0033](./0033-files-only-store-without-a-cache.md) | `33cf178` |
