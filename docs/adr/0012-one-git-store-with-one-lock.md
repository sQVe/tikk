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
- Shell completion is the one read without the lock. It lists ticket IDs and titles for the shell,
  so it must never wait or create the lock file. It reads only the ticket files, writes nothing,
  and may miss or show a stale ticket while a write changes the store. See [ADR
  0034](./0034-shell-completion-calls-back-into-tikk.md).
- A ticket file is written to a temporary file in the same folder and renamed onto the old one, so
  no reader sees half a file. A hash-checked write compares the hash again right before the
  rename, under the exclusive lock.
- `tikk init` takes no lock, because the lock file lives in the store that `init` creates. `init`
  builds the store in a staging folder and renames it into place. When another `init` wins the
  rename, `init` checks the store that won and reports that the store exists.
- Writes never commit, with two exceptions. `tikk init` makes the store's first commit, so the
  store has a `main` branch from the start. `tikk claim` and `tikk release` sync, as below, so a
  claim reaches the other machines without a separate command. `tikk init --remote <url>` clones the remote's `main`,
  or creates the store and pushes `main` when the remote has no branches. It refuses a remote
  whose `main` holds the folder `facts/<machine>/` of the default machine name unless `--machine`
  is given, so two machines never write one fact folder. A relative path that names a folder from
  the caller's working directory resolves from there, and the store saves it as an absolute
  `origin`. Any other relative name stays as given, so a `url.<base>.insteadOf` rewrite applies.
- One sync fetches, then commits and merges in one hold of the exclusive lock, then pushes. A read
  command therefore never sees a half-merged store. The network steps run outside the lock,
  because writers wait for the lock at most five seconds. Each network step stops after 30
  seconds.
- A claim fetches outside the lock. Then, in one hold of the exclusive lock, it merges what it
  fetched, checks the claim, appends the fact, and commits, so no other process can claim between
  the merge and the append. Then it pushes outside the lock. A release does the same. Both use the
  steps of `tikk sync`, but merge before they commit, because the check must see the fetched
  claims. A refused claim and a release of a slice with no claim append nothing and commit nothing.
- In a claim or a release, a failed fetch, merge, commit, or push is a problem in the command's
  `sync` field, not a refusal, and a conflict is aborted and named there. The claim decides on the
  local state it has. A merge that cannot be aborted, or that stays in progress, fails the command
  before it appends, because tikk never appends into an unresolved merge. A refused merge or
  commit also skips the push.
- A failed fetch keeps the local commit and skips the merge and the push, so a stale `origin/main`
  is never merged. A failed push leaves the next sync to push. A network failure is a result, not a
  refusal: sync reports `fetched` or `pushed` as false and names the failure under `problems`.
- Every read of sync returns an error when it fails, and sync finishes its reads before it changes
  a file, the index, or `HEAD`. A failed read never counts as "nothing there". A claim and a release
  finish the same reads before their merge, and read the changed files again after the append, so
  the commit holds the new fact. These reads include the scan of the tickets for ID clashes. After a
  merge, sync scans the tickets again, so the clash list holds the merged tickets. The store has
  changed by then, so a failed second scan is a problem of the `merge` step, not a refusal, and sync
  still pushes. A claim or a release needs the merged tickets for its check, so a failed second scan
  fails it before the append.
- Sync is one function of the core crate that returns its result. `tikk sync`, `tikk claim`, and
  `tikk release` run its steps. No other command syncs, and no command starts a sync in the
  background or leaves a process running after it exits. Other writes reach the remote at the next
  `tikk sync`, `claim`, or `release`.
- `facts/` merges with Git's `union` driver through a normal merge, and facts are append-only. Sync
  refuses a fact file whose committed lines changed or were removed, and changes nothing.
- tikk never rebases, stashes, resets, or drops local content to make a merge work. A merge that a
  pending or changed file would block is refused, and so is a store with a merge in progress or
  with staged changes that sync did not make.
- Any unmerged path is a conflict. tikk aborts the merge, skips the push, stops the sync with the
  code `conflict`, and names each file. No merge is left in progress, and each file keeps the
  local text.
- A changed ticket file is committed only when it parses and has not changed for two seconds.
  Sync waits outside the lock for the rest of the two seconds, then checks once more under the
  lock. A file that changed again stays pending as `settling`, and one that does not parse stays
  pending as `unparsed`. Other files outside `facts/` follow the same two-second rule. Sync stages
  the bytes it checked, not a later read of the file. A claim and a release do not wait: they
  commit the facts and the files that have settled already, and leave younger files pending. Only
  `tikk sync` waits.
- Sync refuses an index with staged changes before it stages, so every entry it stages is its own.
  When staging or the commit fails, sync unstages only those paths and reports the error, so the
  next sync needs no `git reset` by hand.
- Sync saves its last result, or its error, in `.git/tikk-sync.json`, outside the synced content.
  A claim and a release save their sync result there too, also when they refuse.
- The Git calls of sync and `init --remote` run with no hook, no signing, no terminal prompt, no
  autostash, and null standard input, with the fixed identity `tikk`. The local steps (stage,
  commit, merge, and abort) also read no global or system Git config. The network steps (fetch,
  push, the remote read, and clone) keep it, because a private remote over HTTPS needs the user's
  credential helper. They turn hooks and signing off with `-c`, which overrides that config.

## Consequences

### Positive

- Every worktree sees the same store, and PRs carry no ticket noise.
- Git gives backup, history, and undo of intent.

### Negative

- A store lock serializes writes from all agents on a machine.
- Facts are permanent in Git, so a leaked secret needs a history rewrite.
- Two offline machines can claim the same slice. tikk does not report that clash yet.
- The network steps read the user's global Git config, so a setting there that `-c` does not
  override, such as a URL rewrite, changes where sync fetches and pushes.
- A conflict stops every sync until the user merges `origin/main` by hand.
- A claim and a release wait for the network, up to 30 seconds for each network step.

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

### Sync in the background after each write

Let each write start a detached `tikk sync`, and let a burst of writes share one. Rejected because
a background process fails where no caller sees it, and a write would start network work its
caller did not ask for. An explicit sync returns its result, so the caller sees each conflict and
network failure.

### Rebase on sync

Rebase local commits onto the fetched ones. Rejected because an interrupted rebase leaves the
repository half-finished. tikk merges instead.

### A private gist

Sync through a gist. Rejected because a secret gist is not private and has no folders.
