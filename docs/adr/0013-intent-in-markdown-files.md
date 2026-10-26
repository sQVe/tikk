# ADR 0013: Ticket intent in Markdown files

**Date**: 2026-10-18\
**Status**: Accepted

## Context

The user edits tickets outside Neovim today and wants to edit them there. Agents also read and write
tickets, and each write must not overwrite what the user changed.

## Decision

Ticket intent lives in Markdown files with front matter. The user edits them in Neovim. The front
matter holds `kind`, `title`, `project`, `parent`, `rank`, `blockedBy`, `status`, and `criteria`.
The body is prose. zod validates the file.

Stored `status` is only a human decision: `draft`, `open`, or `canceled`, and for tasks also `done`.
Derived states such as ready, active, and done come from facts and are never written to the file. A
file that agents rewrite with state would conflict across machines.

Agent writes check the file's content hash from the cache and refuse when the file changed since the
agent read it. A file that fails to parse keeps its last good state in the cache, shows the error,
and is never rewritten by tikk.

A human ticket may have a folder, `tickets/<project>/<id>/`, beside its file. A plan keeps its
`design.md` and report files there. Sync commits the folder's files as they are. tikk does not
validate them, and the cache never reads them as tickets. `tikk show --json` lists them.

## Consequences

### Positive

- Every field the user owns can be changed in Neovim with no command.
- Git history covers undo of intent.

### Negative

- A hand edit that breaks front matter hides the ticket's new intent until it is fixed.
- Two machines that edit one ticket offline produce a conflict that the user resolves.

## Alternatives considered

### Full event sourcing

Store intent as events and render files from them. Rejected because it needs a clock across
machines, a projection, and compensating events, and the user found it too complex. Revisit if Git
history proves too weak for undo of intent.

### Rendered read-only files

Render Markdown from a database and edit only through `tikk edit`. Rejected because the user wants
to edit ticket files directly.
