# ADR 0033: Every command reads the store files, with no cache

**Date**: 2026-11-12\
**Status**: Accepted\
**Supersedes**: ADR 0017 (A disposable SQLite cache)\
**Related**: [ADR 0013 (Ticket intent in Markdown files)](./0013-intent-in-markdown-files.md),
[ADR 0015 (Observed facts in per-machine JSONL)](./0015-facts-in-per-machine-jsonl.md)

## Context

Agents ask the store many questions, such as which tickets match a filter, which work is ready, and
what a ticket's children are. The answers come from the ticket files and the fact lines.

Many agent processes and the user's editor change those files at the same time. A second copy of
the data must notice every change, or it answers from stale data. A stale answer can show a slice
open or a blocker unmerged.

A store holds a few thousand tickets. A scan of 2,000 small ticket files with a YAML decode takes a
fraction of a second, within the time an agent waits for a command.

## Decision

Every command reads the ticket files and fact lines it needs, and tikk keeps no cache. There is no
SQLite database, no index file, and no daemon. The files in the store are the only state.

### Reads

- A read lists `tickets/<project>/`, parses each ticket file, and filters the result in memory.
  Search is a plain substring match on the title and body, with no index and no ranking.
- A file that fails to parse never stops a read. The listing names its path and error, and the other
  tickets stay readable.
- A ticket's `hash` is the SHA-256 of its file's bytes at read time. A hash-checked write compares
  it with the file on disk.

## Consequences

### Positive

- No answer can be stale, because each command reads the current files.
- A hand edit is visible to the next command with no rescan, watcher, or rebuild.
- There is no schema to migrate and no database file to repair.

### Negative

- Each command's cost grows with the number of ticket files and fact lines. A store far larger than
  a few thousand tickets would need a new decision.
- Queries that join tickets and facts run in Rust code, not in SQL.

## Alternatives considered

### A disposable SQLite cache

Keep a cache that is rebuilt from the files, and rescan changed files before each command. Rejected
because the rescan reads every file's metadata anyway, the cache adds a schema and a rebuild path,
and a missed change gives a stale answer.

### A background daemon

Keep an index fresh with a running process. Rejected because tikk would need to start, stop, and
recover a process on each machine, and a read scan is fast enough without one.

### SQLite as the store

Keep tickets in a database. Rejected because the user edits ticket files in a text editor, and a
binary database does not merge in Git.
