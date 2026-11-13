# ADR 0021: Strict validation at claim, submit, and audit

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0005 (Typed results for expected failures, panics for bugs, and parse-once boundaries)](./0005-results-panics-and-parse-once-boundaries.md),
[ADR 0016 (Evidence records bound to code state)](./0016-evidence-records-and-criteria-coverage.md)

## Context

Tickets must be machine checkable, so agents can rely on them. Agents also must not spend their
effort fighting the validator. A hand edit can break front matter at any time.

## Decision

tikk validates strictly at `claim`, `submit`, and the audit. Prose gets warnings, not errors. Ticket
validation gates never block a `log` line, so a worker can always report progress, questions, and
discoveries. No flag overrides a validation gate.

### Levels

- Strict: front matter fields, the tree, edges, and criteria on plans and slices must be valid at
  claim, submit, and the audit. A command that fails strict validation exits with an error. The
  audit holds the strict check of a slice's criteria.
- Kind only: `tikk done` on a task or an instruction checks only the ticket's kind, and refuses a
  plan or a slice, which has no stored `done` status.
- Warning: prose in the body, and the criteria coverage report. A warning does not stop a command.
- Never blocked by validation: `log` lines. A log line still goes through safe parsing, and it is
  still refused when it names a shared ID under [ADR 0019](./0019-ids-and-file-names.md).

"Never blocked" covers the validation gates only. It does not cover malformed writes or the
shared-ID refusal in [ADR 0019](./0019-ids-and-file-names.md).

## Consequences

### Positive

- Machine-checkable tickets without agents stuck on style rules.
- No action writes data that tikk cannot read.

### Negative

- A warning can be ignored, so weak prose can reach a done task.
- An agent stuck on a gate must fix the ticket first. It cannot skip the gate.

## Alternatives considered

### Block every violation

Refuse any command on any violation. Rejected because agents would fight the validator.

### Validate nothing

Accept any ticket. Rejected because the design needs tickets that machines can check.

### Gate log lines like other writes

Run the validation gates on `log` lines too. Rejected because a worker must always be able to
report, even when a ticket fails validation.
