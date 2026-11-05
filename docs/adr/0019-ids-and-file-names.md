# ADR 0019: Short random IDs and stable file names

**Date**: 2026-11-04\
**Status**: Accepted

## Context

Several machines create tickets offline, so a counter would need a server to hand out numbers. Users
read IDs in an editor and agents pass them on the command line. Open editor buffers break if a file
is renamed.

## Decision

An ID is `<project>-<4 chars>`. The project part is lowercase letters, digits, and hyphens, and must
start with a letter or digit. Each of the four characters is drawn uniformly at random from this
27-character alphabet: `346789abcdefghijkmnpqrtwxyz`. The alphabet leaves out the look-alike
characters 0, 1, 2, 5, `l`, `o`, `s`, `u`, and `v`. The
random source is the operating system's. A new ID never matches a folder name that exists.

Files are `tickets/<project>/<id>-<slug>.md`. The slug is set at create and never renamed
automatically. The one exception is an ID clash found after a sync merge. Then tikk gives the newer
ticket a new ID, renames its file, and writes an `alias` fact from the old ID to the new one. The
alias also names the fact lines that the renamed ticket's side added under the old ID, so those
lines read under the new ID. Fact lines are never rewritten. Until a sync resolves a shared ID,
commands that append a fact for it refuse it with the `idShared` error. An alias whose clash was
abandoned, with no ticket under its new ID, moves nothing, and no new ID takes that ID. The rename
moves the whole folder `tickets/<project>/<id>/` with the ticket file, even when both clashing
tickets had a folder.

The `project` field comes from the repository's `origin` through tikk's config, and is `personal`
outside a repository. It replaces Linear team and project routing.

## Consequences

### Positive

- IDs are short and readable, and need no server.
- An open editor buffer never loses its file.

### Negative

- Two machines can pick the same ID. tikk records an `alias` fact after a clash.
- A slug can drift from a retitled ticket.

## Alternatives considered

### Sequential ticket numbers

Number tickets in order. Rejected because they need a server to hand out numbers.

### Rename the file when the title changes

Keep the slug in step with the title. Rejected because a moved file breaks open editor buffers.

### Rewrite the renamed ticket's fact lines

Change the `ticket` field of each fact line the renamed ticket owns. Rejected because fact files are
append-only ([ADR 0015](./0015-facts-in-per-machine-jsonl.md)).

### Pick the facts by the alias's machine or by time

Take the facts the alias's machine wrote, or the facts before the clash time. Rejected because the
machine that writes an alias can be the one that kept the old ticket, and timestamps do not order
events across machines ([ADR 0015](./0015-facts-in-per-machine-jsonl.md)).
