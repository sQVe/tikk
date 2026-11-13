# ADR 0013: Ticket intent in Markdown files

**Date**: 2026-11-04\
**Status**: Accepted\
**Related**: [ADR 0014 (Git history is undo, with no event sourcing for intent)](./0014-git-history-as-undo.md),
[ADR 0021 (Strict validation at claim, submit, and audit)](./0021-validation-levels.md)

## Context

The user edits tickets in a text editor and wants to keep doing so. Agents also read and write
tickets, and each write must not overwrite what the user changed.

## Decision

Ticket intent lives in Markdown files with YAML front matter. The user edits them in any text
editor. A file is `tickets/<project>/<id>-<slug>.md`. The ID comes from the file name and the
project from the folder, so the front matter has no `project` field. The front matter holds `kind`,
`title`, `status`, `reason`, `parent`, `rank`, `blockedBy`, `discoveredFrom`, `related`, and, on
plans and slices, `criteria`. The body is prose. tikk decodes the front matter with serde and then
checks it with domain validation, which names the field it refuses.

Stored `status` is only a human decision: `draft`, `open`, or `canceled` for plans and slices, and
`open`, `done`, or `canceled` for instructions and tasks. A canceled ticket has a `reason`. The
status and the reason live only in the ticket file, and no fact records them. Derived states such as
ready, active, and done come from facts and are never written to the file. A file that agents
rewrite with state would conflict across machines.

An agent reads a ticket's `hash`, the SHA-256 of its file. Agent writes pass that hash back and are
refused when the file on disk has another hash. A file that fails to parse has no other state: tikk
lists its path and error, refuses to show it as a ticket, and never rewrites it.

A human ticket may have a folder, `tickets/<project>/<id>/`, beside its file. A plan keeps its
`design.md` and report files there. Sync commits the folder's files as they are. tikk does not
validate them and never reads them as tickets. `tikk show --json` lists them.

## Consequences

### Positive

- Every field the user owns can be changed in a text editor with no command.
- Git history covers undo of intent.

### Negative

- A hand edit that breaks front matter hides the whole ticket from reads until it is fixed.
- Two machines that edit one ticket offline produce a conflict that the user resolves.

## Alternatives considered

### Full event sourcing

Store intent as events and render files from them. Rejected because it needs a clock across
machines, a projection, and compensating events, and the user found it too complex. Revisit if Git
history proves too weak for undo of intent.

### Rendered read-only files

Render Markdown from a database and edit only through `tikk edit`. Rejected because the user wants
to edit ticket files directly.
