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
random source is the operating system's. A draw that matches the ID of a ticket file or folder in
the project draws again.

Files are `tickets/<project>/<id>-<slug>.md`. The slug is set at create and never renamed. tikk
never renames a ticket file or folder on its own, not even after an ID clash. An ID clash is two
ticket files in one project with one ID, as a sync merge can bring. tikk reports the clash and
renames nothing: `tikk sync` and `tikk ls` name the ID and both files. Until the user renames one
file, and its folder if it has one, to a new ID, commands that append a fact for the ID refuse it
with the `idShared` error and write nothing. That covers `claim`, `release`, `pr link`, and the
lease renewal by `new`, `done`, and `cancel` on an instruction of the slice. `pr refresh` without a
slice refuses before it runs `gh` when any slice it would read has a shared ID.

Facts cannot tell which of the two tickets they belong to, so tikk derives no state from facts for
a shared ID. `tikk show` of the ID refuses with `idShared` and names both files, and `tikk ready`
skips the slice with the hold `idShared`. There is no `alias` fact. After the rename, the facts
written under the shared ID stay with the ticket that keeps the ID.

A new ticket with a parent is in the parent's project, and a `--project` that differs is refused.
Without a parent, the project is the lowercase repository name of `origin` in the working directory,
or `personal` outside a repository or without an `origin`. `--project` overrides it. The project
replaces Linear team and project routing.

## Consequences

### Positive

- IDs are short and readable, and need no server.
- An open editor buffer never loses its file.

### Negative

- Two machines can pick the same ID. The user renames one file by hand after a clash.
- A slug can drift from a retitled ticket.

## Alternatives considered

### Sequential ticket numbers

Number tickets in order. Rejected because they need a server to hand out numbers.

### Rename the file when the title changes

Keep the slug in step with the title. Rejected because a moved file breaks open editor buffers.

### Rename the newer ticket after a clash

Give the newer ticket a new ID after a sync merge, rename its file, and record an `alias` fact from
the old ID. Rejected because the alias needs rules for which fact lines move to the new ID, a wrong
choice moves another ticket's history, and fact files are append-only
([ADR 0015](./0015-facts-in-per-machine-jsonl.md)). The rename would also break an open editor
buffer.
