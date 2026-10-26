# ADR 0022: Claims with leases and a ready queue that names what it skipped

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0012 (One Git store per user with one lock)](./0012-one-git-store-with-one-lock.md),
[ADR 0015 (Observed facts in per-machine JSONL)](./0015-facts-in-per-machine-jsonl.md),
[ADR 0020 (Edges)](./0020-edges.md)

## Context

Several agents on several machines take work at once. Two agents claiming one instruction at once
must give exactly one winner. An agent that dies must not hold an instruction forever. An agent also
needs to know why it was not given the first item.

Two offline machines can claim the same instruction, and reconcile must show the clash.

## Decision

A `claim` is a fact with a lease. `ready` returns ordered candidates and names what blocks each
skipped item. Before a claim, tikk fetches when the network is up, and merges what it fetched under
the store lock. A failed fetch or a conflicting merge does not stop the claim.

### Claims

- A claim runs under the store lock, so it is atomic
  ([ADR 0012](./0012-one-git-store-with-one-lock.md)). Of two simultaneous claims on one
  instruction, exactly one succeeds.
- A claim has a lease. A claim whose lease ended is stale, and stale claims show in `tikk needs`.
- `release` ends a claim. Both are facts ([ADR 0015](./0015-facts-in-per-machine-jsonl.md)).
- A claim records the agent session that took it, such as the Pi session ID and its log path, so
  `tikk show` points at the log of the work. The log stays outside the store, since raw session
  dumps never enter it.
- Fetching before a claim narrows the window for two machines to claim one instruction. Offline, the
  clash is possible, and reconcile shows it.

### Ready queue

- `ready` returns the ordered candidates, by `rank`, that no `blockedBy` edge holds back
  ([ADR 0020](./0020-edges.md)).
- For each higher-ranked item it skipped, `ready` names what blocks it.
- `ready` takes a scope, such as a plan or a slice. Within a plan it returns the next slice to
  start; within a slice, the next instruction. It weighs order, `blockedBy` edges, and merge state,
  so Tau asks tikk what comes next instead of working out the order itself.

## Consequences

### Positive

- One winner per claim on a machine, and a dead agent's claim can be seen and cleared.
- An agent or the user can see why an item is not ready.

### Negative

- A fetch before each claim adds network time when the network is up.
- Offline machines can still claim the same instruction.

## Alternatives considered

### Claims without a lease

Hold a claim until `release`. Rejected because a dead agent would hold an instruction forever, and
nothing would show it as stale.

### Tau works out the next item itself

Tau reads the plan's slices and decides order, blockers, and merge state on its own, as it does with
Linear today. Rejected because that logic needs order repair, page caps, and one `gh` call per PR in
Tau, and every caller would repeat it.

### Ready returns only the first item

Return the first unblocked item and nothing else. Rejected because the agent could not see what
blocks the items it skipped.

### Claim by writing the ticket file

Mark a claim in the ticket's front matter. Rejected because agent writes to a file conflict across
machines ([ADR 0015](./0015-facts-in-per-machine-jsonl.md)).
