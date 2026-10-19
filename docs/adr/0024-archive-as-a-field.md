# ADR 0024: Archive is a field

**Date**: 2026-10-18\
**Status**: Accepted

## Context

Stale tickets reportedly degrade agents. Finished work should leave the default views. A moved file
breaks open Neovim buffers.

## Decision

Archived is an `archived: <date>` field. tikk sets it automatically 14 days after a plan or
stand-alone ticket is done, canceled, or closed. It then sets it on the plan's slices and tasks. The
user can also set it by hand. Archived tickets leave `ready`, `needs`, `ls`, and the default TUI
views. Files never move.

## Consequences

### Positive

- Open buffers keep their files.
- Default views and agent reads hold only live work.

### Negative

- Archived files stay in the tree and in Git.

## Alternatives considered

### Move files to an archive folder

Move finished tickets out of `tickets/`. Rejected because a moved file breaks open Neovim buffers.

### Never archive

Leave finished tickets in every view. Rejected because stale tickets reportedly degrade agents.
