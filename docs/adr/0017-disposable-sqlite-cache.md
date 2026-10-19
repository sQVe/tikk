# ADR 0017: A disposable SQLite cache

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0015 (Observed facts in per-machine JSONL)](./0015-facts-in-per-machine-jsonl.md)

## Context

Agents need fast reads, such as ready work and what blocks a skipped item. Ticket files and facts
are slow to scan for each question. Derived state needs joins across tickets and facts.

## Decision

A `bun:sqlite` cache at `~/.cache/tikk/index.db` answers queries and holds derived state. The cache
is not in Git and is rebuilt from the ticket files and facts. Deleting it loses nothing. tikk
rebuilds it on a schema change or damage.

Every CLI command rescans changed ticket files first, by modification time and then by hash. The TUI
also watches the files and `facts/`. No daemon runs.

## Consequences

### Positive

- There is one source of truth, the files and facts, so the cache cannot hold lost data.
- A schema change needs no migration.

### Negative

- A rebuild costs time on a large store.
- A stale cache can show a slice open or a blocker unmerged.

## Alternatives considered

### SQLite as the store

Keep tickets in the database. Rejected because the user edits files in Neovim, and a binary database
does not merge in Git.

### A background daemon

Keep the cache fresh with a running process. Rejected because rescans on each command and the TUI
watcher cover updates without a daemon.

### A sync engine

Use a local-first sync engine such as LiveStore. Rejected because it needs a hosted backend and is
in beta. Revisit if a stable self-hosted engine supports many processes on one store.
