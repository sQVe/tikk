# ADR 0021: Strict validation at claim, submit, and close

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0005 (Results for expected failures, exceptions for bugs, and zod at boundaries)](./0005-results-exceptions-and-zod-boundaries.md),
[ADR 0016 (Evidence records bound to code state)](./0016-evidence-records-and-criteria-coverage.md)

## Context

Tickets must be machine checkable, so agents can rely on them. Agents also must not spend their
effort fighting the validator. A hand edit can break front matter at any time.

## Decision

tikk validates strictly at `claim`, `submit`, and `close`. Prose gets warnings, not errors. Log
lines are never blocked. `--force --reason` overrides a strict check.

### Levels

- Strict: front matter fields, the tree, edges, and criteria on plans and slices must be valid at
  claim, submit, and close. A command that fails strict validation exits with an error.
- Warning: prose in the body, and the criteria coverage report. A warning does not stop a command.
- Never blocked: `log` lines, so a worker can always report progress, questions, and discoveries.

### Force

`--force` needs `--reason`. The coverage report stays a warning until the `--force` rate shows
agents can meet it.

## Consequences

### Positive

- Machine-checkable tickets without agents stuck on style rules.
- A forced action carries a reason.

### Negative

- A warning can be ignored, so weak prose can reach a close.
- `--force` can hide a real problem if agents use it too often.

## Alternatives considered

### Block every violation

Refuse any command on any violation. Rejected because agents would fight the validator.

### Validate nothing

Accept any ticket. Rejected because the design needs tickets that machines can check.

### Block log lines on bad input

Validate `log` lines like other writes. Rejected because a worker must always be able to report.
