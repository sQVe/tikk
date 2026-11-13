# ADR 0022: Claims with leases and a ready queue that names what it skipped

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0012 (One Git store per user with one lock)](./0012-one-git-store-with-one-lock.md),
[ADR 0015 (Observed facts in per-machine JSONL)](./0015-facts-in-per-machine-jsonl.md), [ADR 0020
(Edges)](./0020-edges.md)

## Context

Several agents on several machines take work at once. A manager agent takes a slice and runs its
instructions. Two managers claiming one slice at once must give exactly one winner. A manager that
dies must not hold a slice forever, and the user must be able to free it. A manager also needs to
know why it was not given the first slice.

Two offline machines can claim the same slice.

## Decision

A manager claims a slice with a `claim` fact that has a lease of 4 hours. `ready` returns ordered
candidate slices and names what holds each skipped one. Before a claim, tikk fetches when the
network is up, and merges what it fetched under the store lock. A failed fetch or a conflicting
merge does not stop the claim.

### Claims

- Only a slice is claimed. An instruction has no claim of its own, because its slice's claim covers
  it ([ADR 0018](./0018-work-model-and-kinds.md)).
- A claim runs under the exclusive store lock, which covers the check of the current claim and the
  append of the claim fact ([ADR 0012](./0012-one-git-store-with-one-lock.md)). Of two simultaneous
  claims on one slice, exactly one succeeds, and the other exits with 1 and the code `claimed`.
- The lease is 4 hours, and no command sets another length. A claim whose lease ended is stale.
  Another agent may then claim the slice, and stale claims show in `tikk needs`.
- A claim by the holder renews its lease. A write by the holder to its slice's work renews it too:
  `tikk new`, `done`, and `cancel` on the slice's instructions, and `pr link`, `ask`, and `audit`.
  One shared function appends a `claim` fact with the new lease end after the command's own write,
  in the same hold of the lock. The write and the fact append are not one transaction: when the
  append fails, the command reports the error, and its write stays.
- When `TIKK_AGENT` is set and another agent holds a live claim on the slice, `claim`, `release`,
  and `new`, `done`, and `cancel` on the slice's instructions refuse with the code `claimed`. The
  refusal writes nothing. A person, with no `TIKK_AGENT`, is never refused.
- `release` ends a claim. An agent ends its own claim or a stale one. A person ends any claim, so
  the user can free the slice of a dead manager. Claims and releases are facts
  ([ADR 0015](./0015-facts-in-per-machine-jsonl.md)).
- A claim records the agent session that took it, from `TIKK_SESSION` and `TIKK_SESSION_LOG`, so
  `tikk show` points at the log of the work. The log stays outside the store, since raw session
  dumps never enter it.
- Fetching before a claim narrows the window for two machines to claim one slice. Offline, the
  clash is possible, and tikk does not report it.

### Ready queue

- `ready` lists every slice that can start, in `rank` order, then by ID. It lists every other slice
  in its scope as skipped, and names what holds it.
- The scope is a plan, or a project. Without a plan, it is the project that `tikk new` would choose
  in the working directory, unless the caller names another.
- Only an `open` slice can start. A `draft` slice is skipped as a draft. Done and canceled slices
  are not listed.
- A slice whose plan is `draft` or `canceled` is skipped, and the hold names the plan and its
  status. A draft plan is not yet agreed, and a canceled plan's slices never start. A plan that is
  done does not hold its slices.
- A slice is held back by its own `blockedBy` edges and by those of its plan ([ADR
  0020](./0020-edges.md)). A blocker that both levels name is listed once, at the slice. A blocker
  from the plan names the plan that holds it. A blocker that is missing or does not parse holds the
  slice and is named as such, because tikk cannot tell that it is done.
- A slice with a live claim is skipped, and names its holder.
- The stacking exception: a slice's own `blockedBy` may name a slice whose PR is open. That blocker
  counts as cleared for the slice, and the ready slice names that PR as its stack parent. A task or
  plan blocker never clears this way.
- `ready` weighs order, `blockedBy` edges, claims, and merge state, so Tau asks tikk what comes next
  instead of working out the order itself.

## Consequences

### Positive

- One winner per claim on a machine, and a dead manager's claim can be seen and cleared.
- An active manager keeps its claim through its own writes, with no separate renewal call.
- An agent or the user can see why a slice is not ready.

### Negative

- A fetch before each claim adds network time when the network is up.
- Offline machines can still claim the same slice, and nothing reports it.
- A manager that writes nothing for 4 hours loses its claim to the next agent that asks.
- A failed fact append after a write leaves the write in place with the old lease end.

## Alternatives considered

### Claims on instructions

Let each worker claim its instruction. Rejected because the manager runs the slice and its
instructions as one branch and one PR, so one claim per slice is the unit that must not be shared.

### A lease length per claim

Let `claim` take a lease length. Rejected because an agent would ask for long leases, and a dead
one would then hold its slice longer. Renewal on the holder's writes keeps an active claim alive.

### Claims without a lease

Hold a claim until `release`. Rejected because a dead agent would hold a slice forever, and nothing
would show it as stale.

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
