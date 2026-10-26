# ADR 0019: Short random IDs and stable file names

**Date**: 2026-10-18\
**Status**: Accepted

## Context

Several machines create tickets offline, so a counter would need a server to hand out numbers. Users
read IDs in Neovim and agents pass them on the command line. Open Neovim buffers break if a file is
renamed.

## Decision

IDs are `<project>-<4 chars>`. The characters come from nanoid with a lowercase alphabet that leaves
out look-alike characters. Files are `tickets/<project>/<id>-<slug>.md`. The slug is set at create
and never renamed automatically. The one exception is an ID clash found after a sync merge. Then
tikk gives the newer ticket a new ID, renames its file, and writes an `alias` fact from the old ID
to the new one. The rename moves the whole folder `tickets/<project>/<id>/` with the ticket file,
even when both clashing tickets had a folder. A new ID never matches a folder name that exists.

The `project` field comes from the repository's `origin` through tikk's config, and is `personal`
outside a repository. It replaces Linear team and project routing.

## Consequences

### Positive

- IDs are short and readable, and need no server.
- An open buffer never loses its file.

### Negative

- Two machines can pick the same ID. tikk records an `alias` fact after a clash.
- A slug can drift from a retitled ticket.

## Alternatives considered

### Sequential ticket numbers

Number tickets in order. Rejected because they need a server to hand out numbers.

### Rename the file when the title changes

Keep the slug in step with the title. Rejected because a moved file breaks open Neovim buffers.
