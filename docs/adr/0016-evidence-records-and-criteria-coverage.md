# ADR 0016: Evidence records bound to code state, finding status from triage, and coverage as a query

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0015 (Observed facts in per-machine JSONL)](./0015-facts-in-per-machine-jsonl.md),
[ADR 0018 (Plans, slices, tasks, and issues)](./0018-work-model-and-kinds.md),
[ADR 0023 (A slice is done when its PR merged and its criteria are met)](./0023-derived-slice-done.md)

## Context

In Linear, acceptance is copied into each ticket and mapped by hand twice, and again word for word
at launch. Review and audit reports are comments found by their first line. Triage outcomes and QA
results live only in the session.

Tau's full-check records already bind a run to a head, a base, and a change hash.

## Decision

Reviews, checks, QA runs, and audits are fact records that carry the code state they saw. Finding
status comes from triage facts. Criteria coverage is a query.

### Evidence records

- A `check`, `review`, `audit`, or `qa` record carries repository, head, base, and a change hash. A
  record for other code does not count for the current head.
- A `review` holds `finding`s. A `check` holds none. Triage appends a fact that changes a finding's
  status. The newest line wins, as for all facts.
- An `audit` holds one verdict per criterion.

### Criteria

- Criteria live in the front matter of plans and slices, each with a stable ID, a check method, an
  expected result, and `covers` links from slices and tasks.
- A task covers all of its slice's criteria unless it names some.
- Coverage is a query over criteria and `covers` links. No ticket copies criteria text.
- The coverage report is a warning until the `--force` rate shows agents can meet it.

## Consequences

### Positive

- A stale audit or review is visible, because it names the code it saw.
- Acceptance is written once and mapped by query, not by hand.
- Findings and their status are searchable, not comments.

### Negative

- Agents may write criteria and coverage links that pass the check but test nothing, so finish-slice
  and code-review keep their judgment.
- Agents must write criteria IDs and `covers` links.

## Alternatives considered

### Reports as ticket comments

Keep reviews and audits as comments found by their first line. Rejected because the reader must find
them by text, and nothing binds them to the code they saw.

### Finding status in the ticket file

Write each finding's status into a file. Rejected because agent writes to a file conflict across
machines, as for all derived state ([ADR 0013](./0013-intent-in-markdown-files.md)).

### An outcome graph only

Model acceptance as a graph of outcomes. Rejected because it is hard to read and execute. Its shared
checks live on as criteria.
