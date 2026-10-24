# ADR 0015: Observed facts in per-machine JSONL

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0012 (One Git store with one lock)](./0012-one-git-store-with-one-lock.md)

## Context

Claims, progress logs, PR states, reviews, and audits are observations, not intent. Many agents and
several machines write them. Writing them into ticket files would cause conflicts and mix them with
the user's text.

## Decision

Observed facts live in append-only JSONL under `facts/<machine>/`. Each machine writes only its own
folder, so two machines never edit one file.

Each line is one versioned JSON observation and is never edited. A correction is one more line, and
the newest line wins. Across machines, facts are ordered by timestamp, then file path in lexical
order, then line number, all ascending. The last fact in that order wins when observations replace
the same state. File path and line number break timestamp ties deterministically; they do not
establish which observation happened later in real time. Machine clocks can disagree, so timestamp
order is not a guarantee of real-time order.

Evidence records carry the code state they saw: repository, head, base, and a change hash. Large
logs and screenshots are stored by content hash. Secrets and raw session dumps never enter the
store.

## Consequences

### Positive

- Offline machines sync with no Git conflict.
- Evidence is bound to the code state it saw, so a stale audit is visible.

### Negative

- Facts stay in Git history forever.
- Readers need the cache to see current state, because the files hold every past line.

## Alternatives considered

### Facts inside ticket files

Write claims and logs into the ticket. Rejected because agent writes would conflict across machines
and mix with the user's edits.

### Evidence as comments on tickets

Keep reviews and audits as comments, as Linear does. Rejected because the design needs reviews,
checks, QA, and audits as records bound to the code state they saw and open to queries, and comments
on tickets are prose found by their first line.
