# ADR 0011: One user, with no ownership, permissions, or assignees

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0022 (Claims with leases and a ready queue)](./0022-claims-leases-and-ready-queue.md)

## Context

The user and agents write tickets. About 95% of the work is single-user. Linear is built for human
teams, and Tau carries code for ownership reads that only approval uses.

## Decision

tikk serves one user and their agents. It has no ownership checks, no permissions, no sharing, and
no assignees. Several machines belong to the same user and sync through one private repository
([ADR 0012](./0012-one-git-store-with-one-lock.md)).

Multi-user collaboration, permissions, and assignees are non-goals. A worker that takes a task holds
a claim with a lease, not an assignment ([ADR 0022](./0022-claims-leases-and-ready-queue.md)).

## Consequences

### Positive

- No ownership checks or permission code to write, test, or keep in step with Linear.
- Every command can trust that the writer is the user or one of their agents.

### Negative

- A second user cannot use the same store. Supporting them would need a new ADR.

## Alternatives considered

### Design for several users now

Add owners, permissions, and assignees from the start. Rejected because about 95% of the work is
single-user, and it would bring back the ownership code that Linear forced on Tau.

### Assign tasks to agents by name

Record an assignee on each task. Rejected because a claim with a lease already shows which worker
holds a task, and an assignee would need ownership checks.
