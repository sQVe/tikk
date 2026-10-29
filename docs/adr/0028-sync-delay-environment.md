# ADR 0028: Sync delays come from environment variables

**Date**: 2026-10-29\
**Status**: Accepted\
**Related**: [ADR 0005 (Results for expected failures, exceptions for bugs, and zod at boundaries)](./0005-results-exceptions-and-zod-boundaries.md),
[ADR 0007 (Side effects as narrow function records)](./0007-side-effect-function-records.md)

## Context

Background sync waits for a debounce after the last write, and a ticket file is committed only after
it has stopped changing for a settle delay. The defaults are 3000 and 2000 milliseconds. A person
may still be editing a ticket file during the settle delay, so the default protects that edit.

Tests run the real CLI in child processes, which cannot receive an in-process fake clock. With the
defaults, each test waits out these delays on every write, so the sync tests and the mutation runs
are slow.

## Decision

The CLI reads its sync debounce and settle delays from `TIKK_SYNC_DEBOUNCE_MILLISECONDS` and
`TIKK_SYNC_SETTLE_MILLISECONDS`, which take whole milliseconds. The CLI parses them once at startup,
and the defaults apply when a variable is unset.

The debounce must be at least 1000 milliseconds. The background sync waits for the debounce before
it removes the marker that the parent wrote for it, and the parent writes that marker just after it
starts the child. The debounce gives the parent that time, so a shorter debounce could let the child
finish before the marker names it. The settle delay has no minimum, and it does not cover this race.

A value that is not a whole number, or a debounce below the minimum, stops the CLI before any
command runs. It reports an `invalidSyncDelay` error, as JSON with `--json` and as plain text
otherwise, and exits with 1.

The background sync that a write starts gets the same two values in its environment, so it uses the
delays of the CLI that started it.

## Consequences

### Positive

- Tests of the real CLI run with short delays, which makes the sync tests and mutation runs faster.
- The sync code takes the delays as values in its function records, so it does not read the
  environment.

### Negative

- A short settle delay can commit a ticket file while a person is still editing it.
- A user who sets these variables in a shell changes sync timing for every tikk command in that
  shell.

## Alternatives considered

### A fake clock in the tests

Rejected because the sync tests run the CLI in child processes, and a child cannot use a fake clock
from the test.

### A config file key

Rejected because `~/.config/tikk/config.json` holds settings that users own, and these delays are
for tests and tuning. A config key would make them a user-facing setting to support.

### Shorter defaults for every run

Rejected because the settle delay keeps a partly written ticket file out of a commit, and a shorter
default would commit such files.
