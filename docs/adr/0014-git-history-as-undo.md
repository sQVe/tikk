# ADR 0014: Git history is undo, with no event sourcing for intent

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0013 (Ticket intent in Markdown files)](./0013-intent-in-markdown-files.md),
[ADR 0012 (One Git store per user with one lock)](./0012-one-git-store-with-one-lock.md)

## Context

The design explored full event sourcing with a hybrid logical clock, for replay and undo of ticket
intent. The user found the full event model too complex.

Intent lives in Markdown files in a Git repository ([ADR 0013](./0013-intent-in-markdown-files.md)).
Git already records every change to those files.

## Decision

tikk does not use event sourcing for intent. The ticket files are the state, and Git history is the
record of change and the way to undo it. Observed facts stay append-only
([ADR 0015](./0015-facts-in-per-machine-jsonl.md)), but they are observations, not events that
rebuild intent.

Revisit this if Git history proves too weak for undo of intent.

## Consequences

### Positive

- No clock across machines, no projection, and no compensating events.
- The user can read and fix a ticket with a text editor and `git`.

### Negative

- Undo of intent is a Git operation, not a tikk command.
- History is only as fine as sync commits, because writes never commit.

## Alternatives considered

### Full event sourcing

Store intent as events and render files from them. Rejected because it needs a clock across
machines, a projection, and compensating events, and the user found it too complex.

### A sync engine

Use a sync engine such as LiveStore for state. Rejected because it needs a hosted backend and is in
beta. Revisit if a stable self-hosted engine supports many processes on one store.
