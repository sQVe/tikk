# ADR 0020: Edges are `blockedBy`, `discoveredFrom`, and `related`

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0018 (Plans, slices, instructions, and tasks)](./0018-work-model-and-kinds.md),
[ADR 0022 (Claims with leases and a ready queue)](./0022-claims-leases-and-ready-queue.md)

## Context

The `parent` field gives a tree: plan above slice above instruction. Work also depends on other
work, and workers find new work while they do an instruction. Ready queues, `discovered-from` links,
and typed links are common across agent trackers.

## Decision

Tickets link to each other with three edges in front matter, besides `parent`:

- `blockedBy`: the ticket cannot start until the target is done. It affects readiness.
- `discoveredFrom`: the ticket was found while working on the target. It does not affect readiness.
- `related`: a plain link with no effect on readiness.

Only `blockedBy` is read by the ready queue ([ADR 0022](./0022-claims-leases-and-ready-queue.md)).
Any ticket, a task too, can be a `blockedBy` target. A done or canceled target no longer blocks.

## Consequences

### Positive

- Readiness has one cause, so `ready` can name what blocks each skipped item.
- A discovered task keeps its link to the work that found it.

### Negative

- Agents and the user must pick the right edge. A `related` link used for a real dependency does not
  block anything.

## Alternatives considered

### The tree alone

Express order only through `parent` and `rank`. Rejected because the tree alone copied Linear.

### One edge type

Use `blockedBy` for every link. Rejected because a discovered or related ticket would then block
work it does not block.
