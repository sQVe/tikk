# ADR 0034: Shell completion calls back into tikk

**Date**: 2026-11-13\
**Status**: Accepted\
**Related**: [ADR 0010 (The CLI for agents is non-interactive and matches the desktop app)](./0010-cli-contract-for-agents.md),
[ADR 0012 (One Git store per user with one lock)](./0012-one-git-store-with-one-lock.md)

## Context

The user types `tikk` commands in bash, zsh, and fish. Most arguments are ticket IDs, which are
random and hard to type. A completion script written once cannot know the IDs, because they live in
the store and change with each new ticket. So the shell has to ask a program for them at the
moment the user presses Tab.

Some arguments accept only some tickets. `tikk move <id> --parent` takes only a parent kind that
the ticket's kind accepts, and `tikk rank <id> --before` takes only a sibling. The candidates
depend on the subject ID, which is another word on the same command line.

A shell waits for the answer while the user types. A completion that waits for the store lock, or
that writes, would make Tab hang or change the store.

## Decision

The completion script calls the `tikk` binary back with `COMPLETE=<shell>` and the words of the
command line, and tikk prints the candidates. This is the dynamic completion of `clap_complete`
(its `unstable-dynamic` feature with `CompleteEnv`), so the clap command tree of `tikk` is the one
source of commands, flags, and candidates.

### The script

- `tikk completions <bash|zsh|fish>` prints the registration script, the same text that
  `COMPLETE=<shell> tikk` prints. The script names the program by the path `tikk` was started
  with, and calls it back with `COMPLETE` set.
- `tikk completions <shell> --json` prints `{"script":"<the script>"}`, like every other command
  result.
- The user loads the script when the shell starts, so the script always matches the installed
  binary. The help of `tikk completions` says how for each shell.

### The callback

- When `COMPLETE` names a shell, tikk answers the shell before it parses the command and exits
  with 0. A shell name that `clap_complete` does not know is an error.
- Each argument that takes a ticket ID offers the IDs of the store, with each ticket's title as
  the description. bash shows the IDs only, because its stock completion has no descriptions. zsh
  and fish show the titles.
- A blocker accepts every kind, so it offers every ID. `move --parent` offers the tickets whose
  kind the subject's kind can sit under, and `rank --before` and `--after` offer the subject's
  siblings. These use the same rules as the commands. A candidate hook gets no parsed arguments,
  so tikk finds the subject in the words that the shell passes. Without a subject, or with an
  unknown one, every ID is offered.
- The callback reads the ticket files without the store lock, without facts, and without a sync,
  Git, or `gh`. It writes nothing. A file that does not parse is left out. A store that is missing
  or cannot be read gives no candidate and no error output, because a prompt has no place for one.

## Consequences

### Positive

- Commands, flags, and IDs complete from one clap tree, so a new command or argument completes
  without a change to any script.
- Completion never waits for a writer and never changes the store.

### Negative

- `clap_complete` marks the callback protocol unstable. A script saved by an older tikk may not
  match a newer binary, which is why the script is loaded at each shell start.
- Each Tab starts `tikk` and scans the ticket files.
- Completion may read the store while a write changes it, so a candidate may be missing or stale
  for that moment.
- bash shows no titles.

## Alternatives considered

### Static scripts from `clap_complete::generate`

Print a fixed script per shell. Rejected because a fixed script cannot offer the store's IDs.

### Hand-written scripts per shell

Write a bash, zsh, and fish script that calls `tikk ls --json` for IDs. Rejected because each
script repeats the command tree and the kind rules, and `tikk ls` takes the store lock.

### Completion through the normal read

Read the IDs the way `tikk ls` does, under the shared lock. Rejected because Tab would wait up to
five seconds while a write or a sync holds the lock, and the read creates the lock file.
