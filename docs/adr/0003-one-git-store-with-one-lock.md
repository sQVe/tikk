# ADR 0003: One Git store per user with one lock

**Date**: 2026-10-18\
**Status**: Accepted

## Context

The user works on several machines and in many repositories, and several agents write at the same
time. Tickets need backup, history, and sync, with no server we run. Every worktree must see the
same tickets at once, and ticket changes must not appear in PRs.

Many agents running Git at once can leave a stale `index.lock` or a half-finished rebase. Two
machines that add facts offline must not produce a Git conflict.

## Decision

tikk keeps one store per user at `~/.local/share/tikk`. The store is a Git repository synced to a
private GitHub repository.

### Locking and sync

- One store lock covers every write and sync. A claim is atomic, and no write races a Git operation.
  tikk clears a stale lock by checking its PID.
- Writes never commit. One sync step commits, fetches, and merges under the same lock. It is
  debounced to at most once every few seconds.
- `facts/` merges with Git's `union` driver, so it never conflicts. tikk never rebases.
- A conflict can occur only in `tickets/`, when two machines edited one ticket offline. tikk stops
  the sync and names the file.
- Hand edits are committed by sync only when the file parses and has not changed for two seconds.

## Consequences

### Positive

- Every worktree sees the same store, and PRs carry no ticket noise.
- Git gives backup, history, and undo of intent.

### Negative

- A store lock serializes writes from all agents on a machine.
- Facts are permanent in Git, so a leaked secret needs a history rewrite.
- Two offline machines can claim the same task. Reconcile must show the clash.

## Alternatives considered

### A store inside each repository

Keep tickets in the repository they describe. Rejected because tickets would show up in PRs, and
worktrees would not share one view.

### Commit on every write

Let each write commit. Rejected because many agents committing at once jam Git.

### Rebase on sync

Rebase local commits onto the fetched ones. Rejected because an interrupted rebase leaves the
repository half-finished. tikk merges instead.

### A private gist

Sync through a gist. Rejected because a secret gist is not private and has no folders.
