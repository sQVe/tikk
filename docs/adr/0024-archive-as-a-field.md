# ADR 0024: Archive is a field

**Date**: 2026-10-18\
**Status**: Accepted

## Context

Stale tickets reportedly degrade agents. Finished work should leave the default views. A moved file
breaks open editor buffers.

## Decision

Archived is an `archived: <date>` field. tikk sets it automatically 14 days after a plan or
stand-alone ticket is done or canceled. It then sets it on every ticket below that one, tasks
included. Archived tickets leave `ready`, `needs`, `ls`, and the default desktop views. Files never
move.

The finish date is the newest `status` fact that names the ticket's current status, or the `accept`
fact of a done instruction. A plan or slice whose done is derived has no such fact. Its finish date
is the newest fact that completed the done conditions: the merge, the audit, or the finish of the
last child that counted. A status set by a hand edit has no fact. tikk appends a `status` fact when
it first sees that edit, and the 14 days start at that fact.

`tikk archive` sets the field by hand. `tikk unarchive` removes it and appends an `unarchive` fact
for each ticket it clears. tikk does not archive that ticket again for a finish older than the fact.
A field removed by hand leaves no fact, so tikk sets it again.

## Consequences

### Positive

- Open editor buffers keep their files.
- Default views and agent reads hold only live work.

### Negative

- Archived files stay in the tree and in Git.
- A command that finds due work takes the store lock and writes ticket files before it runs.

## Alternatives considered

### Move files to an archive folder

Move finished tickets out of `tickets/`. Rejected because a moved file breaks open editor buffers.

### Never archive

Leave finished tickets in every view. Rejected because stale tickets reportedly degrade agents.
