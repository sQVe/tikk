# ADR 0012: One Git store per user with one lock

**Date**: 2026-11-04\
**Status**: Accepted\
**Related**: [ADR 0015 (Observed facts in per-machine JSONL)](./0015-facts-in-per-machine-jsonl.md),
[ADR 0010 (The CLI contract for agents)](./0010-cli-contract-for-agents.md)

## Context

The user works on several machines and in many repositories, and several agents write at the same
time. Tickets need backup, history, and sync, with no server that tikk runs. Every worktree must see
the same tickets at once, and ticket changes must not appear in PRs.

Many agents running Git at once can leave a stale `index.lock` or a half-finished rebase. Two
machines that add facts offline must not produce a Git conflict.

## Decision

tikk keeps one store per user at `~/.local/share/tikk`, or at `$TIKK_HOME` when it is set. The store is a Git repository synced to a
private GitHub repository.

### Locking and sync

- One store lock covers every write and every local Git step of sync. A claim is atomic, and no
  write races a Git operation.
- The store lock is an operating system file lock on `.git/tikk.lock`, taken through
  `std::fs::File`. The operating system releases it when the process ends, so a crashed process
  leaves no stale lock, and tikk keeps no PID file.
- A command that writes, `tikk new` included, and each local Git step of sync take the lock
  exclusive. A command that reads takes it shared, so readers do not block each other and never
  read while a write or a sync changes files. A command waits for the lock at most five seconds,
  then fails with the code `locked`.
- A ticket file is written to a temporary file in the same folder and renamed onto the old one, so
  no reader sees half a file. A hash-checked write compares the hash again right before the
  rename, under the exclusive lock.
- `tikk init` takes no lock, because the lock file lives in the store that `init` creates. `init`
  builds the store in a staging folder and renames it into place. When another `init` wins the
  rename, `init` checks the store that won and reports that the store exists.
- Writes never commit. `tikk init` is the one exception: it makes the store's first commit, so the
  store has a `main` branch from the start. One sync step fetches, then commits and merges under the lock, then pushes.
  The network steps run outside the lock, because writers wait for the lock at most five seconds.
  Each network step has a timeout, and a failed one leaves the sync to the next run.
- The sync step is one function of the core crate, and `tikk sync` runs it. A write on a store with
  an `origin` remote starts a detached `tikk sync` process, unless a live one is waiting. The
  waiting process sleeps three seconds first, so a burst of writes shares one sync.
- `facts/` merges with Git's `union` driver, so it never conflicts. tikk never rebases.
- A conflict can occur only in `tickets/`, when two machines edited one ticket offline. tikk aborts
  the merge, skips the push, stops the sync, and names the file. No merge is left in progress.
- Hand edits are committed by sync only when the file parses and has not changed for two seconds.

## Consequences

### Positive

- Every worktree sees the same store, and PRs carry no ticket noise.
- Git gives backup, history, and undo of intent.

### Negative

- A store lock serializes writes from all agents on a machine.
- Facts are permanent in Git, so a leaked secret needs a history rewrite.
- Two offline machines can claim the same instruction. Reconcile must show the clash.

## Alternatives considered

### A store inside each repository

Keep tickets in the repository they describe. Rejected because tickets would show up in PRs, and
worktrees would not share one view.

### Commit on every write

Let each write commit. Rejected because many agents committing at once jam Git.

### A lock file with a PID

Create a lock file that holds the writer's PID, and clear it when that process is gone. Rejected
because a crash leaves the file behind, and the next command must guess whether the PID still
belongs to tikk. The operating system lock ends with its process.

### Rebase on sync

Rebase local commits onto the fetched ones. Rejected because an interrupted rebase leaves the
repository half-finished. tikk merges instead.

### A private gist

Sync through a gist. Rejected because a secret gist is not private and has no folders.
