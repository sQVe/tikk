# ADR 0016: Evidence records bound to code state, finding status from triage, and coverage as a query

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0015 (Observed facts in per-machine JSONL)](./0015-facts-in-per-machine-jsonl.md),
[ADR 0018 (Plans, slices, instructions, and issues)](./0018-work-model-and-kinds.md),
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
  status. The newest fact wins in the ordering defined by ADR 0015.
- An `audit` holds one verdict per criterion.
- A `qa` record is one QA run on a slice. It holds a run ID, scenarios, artifacts, and gaps. Each
  scenario has a name, the criteria it covers, what was observed, and a verdict of `pass`, `fail`,
  or `blocked`. The run ID is the first 12 hex characters of a SHA-256 of the fact without `run`.
  `tikk qa add` refuses a ticket that is not a slice, a criterion the slice does not have, and a
  repository that is not `owner/name`, since an audit could never cite that run.
- An audit verdict may cite QA runs by run ID. `tikk audit` refuses a cited run that is not a `qa`
  record of the slice, was seen at another repository or head than the audit, or has no scenario for
  the verdict's criterion. It also refuses a `met` verdict that cites a run whose scenario for that
  criterion is `fail` or `blocked`.

### Finding identity and continuity

A finding's identity is its ticket plus its fingerprint. The same fingerprint on another ticket is
not the same finding. Reviews retain that identity across code states. Finding details come from the
newest review that contains the fingerprint; triage status comes from the newest explicit triage
fact for that identity, or is `open` when none exists.

A finding's match against the newest review is separate from its triage status. It is `new` when
first seen there, `unchanged` when also seen in an earlier review, and `absent` when missing there.
Absence does not clear explicit triage status or mean the finding is fixed. A blocked finding can
therefore still need attention after it becomes absent.

Persistent triage records a decision about a finding, not evidence that the finding remains in the
current code. Neither continuity nor an `unchanged` match makes an earlier review current-code
evidence; the review must still match the code state being assessed.

### Criteria

- Criteria live in the front matter of plans and slices, each with a stable ID, a check method, an
  expected result, and `covers` links from slices and instructions.
- An instruction covers all of its slice's criteria unless it names some.
- Coverage is a query over criteria and `covers` links. No ticket copies criteria text.
- A slice covers the plan criteria in its `covers`. A slice with no `covers` covers none. Only
  slices cover plan criteria, and only instructions cover slice criteria.
- A canceled slice or instruction covers nothing, and a canceled plan or slice reports no gaps.
  Archived tickets are left out. A `covers` ID that names no criterion of the parent is ignored.
- `tikk coverage [<id>]` reports each plan criterion that no slice covers and each slice criterion
  that no instruction covers. It takes a plan or a slice and exits 0 when it finds gaps.
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
