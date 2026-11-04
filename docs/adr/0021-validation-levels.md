# ADR 0021: Strict validation at claim, submit, and done

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0005 (Typed results for expected failures, panics for bugs, and parse-once boundaries)](./0005-results-panics-and-parse-once-boundaries.md),
[ADR 0016 (Evidence records bound to code state)](./0016-evidence-records-and-criteria-coverage.md)

## Context

Tickets must be machine checkable, so agents can rely on them. Agents also must not spend their
effort fighting the validator. A hand edit can break front matter at any time.

## Decision

tikk validates strictly at `claim`, `submit`, and `done`. Prose gets warnings, not errors. Ticket
validation gates never block a `log` line, so a worker can always report progress, questions, and
discoveries. `--force --reason` overrides a validation gate.

### Levels

- Strict: front matter fields, the tree, edges, and criteria on plans and slices must be valid at
  claim, submit, and done. A command that fails strict validation exits with an error.
- Warning: prose in the body, and the criteria coverage report. A warning does not stop a command.
- Never blocked by validation: `log` lines. A log line still goes through safe parsing, and it is
  still refused when it names a shared ID under [ADR 0019](./0019-ids-and-file-names.md).

"Never blocked" covers the validation gates only. It does not cover malformed writes or the
shared-ID refusal in [ADR 0019](./0019-ids-and-file-names.md).

### Force

- `--force` needs `--reason`. It overrides a validation gate only.
- `--force` never bypasses safe parsing or the shared-ID refusal in [ADR
  0019](./0019-ids-and-file-names.md).
- The coverage report stays a warning until the `--force` rate shows agents can meet it.

## Consequences

### Positive

- Machine-checkable tickets without agents stuck on style rules.
- A forced action carries a reason, and it cannot write data that tikk cannot read.

### Negative

- A warning can be ignored, so weak prose can reach a done task.
- `--force` can hide a real problem if agents use it too often.

## Alternatives considered

### Block every violation

Refuse any command on any violation. Rejected because agents would fight the validator.

### Validate nothing

Accept any ticket. Rejected because the design needs tickets that machines can check.

### Gate log lines like other writes

Run the validation gates on `log` lines too. Rejected because a worker must always be able to
report, even when a ticket fails validation.
