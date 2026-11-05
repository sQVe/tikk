# ADR 0009: Owner files inside modules, thin coordinators, and owner-first file names

**Date**: 2026-11-04\
**Status**: Accepted\
**Related**: [ADR 0006 (Capability modules with an enforced dependency table)](./0006-capability-modules.md),
[ADR 0005 (Typed results for expected failures, panics for bugs, and parse-once
boundaries)](./0005-results-panics-and-parse-once-boundaries.md)

## Context

[ADR 0006](./0006-capability-modules.md) decides which modules exist and which may use which. It
says nothing about how code is arranged inside a module. Without a rule, features go into a few
central files.

Agents write most features as slices that run in parallel branches. When every slice edits the same
central file, the branches conflict there, and a reader must scan one long file to find one feature.
The conflicts come from shared editing paths, not from size.

## Decision

Inside each module, code for one owner lives in private files named owner first. The module's
coordinators hold only dispatch, lifecycle, and the order that must stay central. Size is a reason
to review a file, never a check that fails.

### Owners

- An owner is a user-facing noun for behavior that changes on its own, whether an entity or a
  capability. Use the same noun for it in every module, so its CLI, cache, and desktop files share a
  prefix.
- Infrastructure that belongs to no feature has its own owner noun, such as `lock` or `clock`.
- An owner may have several files, one per behavior that changes on its own, such as parsing,
  transitions, and effects. Keep a resource's lifetime or one state machine in one file.
- Extract shared code when two existing consumers need it.

### Coordinators

- A coordinator dispatches to owner files and keeps the order that must stay central. It holds no
  owner-specific behavior.
- A feature edits a coordinator only to register a command, an action, or a layout slot, or to
  change a public contract. Keep those edits small and explicit.
- Entry files stay the public API that [ADR 0006](./0006-capability-modules.md) defines.

### File names

- Name a private file `<owner><job>` in snake_case, with a singular owner noun first, such as
  `claim_transitions.rs` or `ticket_parse.rs`.
- A file may use the owner noun alone when that noun names what the file holds. A plural noun alone
  names a collection.
- A view file starts with the owner it shows, such as `claim_row.rs` for a claim row.
- Types use PascalCase, and functions start with a verb. The owner-first order applies to file names
  only.

### Tests

- Unit tests sit in a `#[cfg(test)]` module in the file they test. A split source file splits its
  tests with it.
- Integration tests in `tests/` are named for their owner and behavior. Setup that two or more test
  files share lives in one shared module in `tests/`. Setup used by one suite stays in that suite.

### Size

- Review a file over 500 lines, a function over 60 lines, or a function with more than four
  parameters. Split by responsibility, not to meet a count.
- These limits are review signals. No check fails on them.

## Consequences

### Positive

- Parallel slices for different owners edit different files, so they conflict less.
- A reader finds a feature by its noun, and sorted listings group `claim*` files together.
- Coordinators stay short because they hold dispatch and ordering only.

### Negative

- One feature spans several small files across modules, so a change opens more files.
- Each new command or layout slot still edits its coordinator once to register.
- Choosing an owner noun is a judgment call, and two slices can pick different nouns for one
  feature.
- Without a failing check, the size signals depend on review and can drift.

## Alternatives considered

### Keep growing the central files

Keep one file per module and rely on review to keep it readable. Rejected because every parallel
slice would edit the same blocks.

### A hard line limit in the check

Make the check refuse files over 500 lines. Rejected because a count does not show ownership. It
would force splits of cohesive files, while a coordinator under the limit could still hold every
feature.

### One folder per feature across modules

Use one folder per feature that holds its store, CLI, and UI code. Rejected because it breaks the
capability modules of [ADR 0006](./0006-capability-modules.md): pure and UI code would share a
folder, and the table could no longer tell them apart.

### Split by kind of code

Use files such as `types.rs`, `handlers.rs`, and `parsers.rs` inside each module. Rejected because
one feature would spread across every file, and [ADR 0006](./0006-capability-modules.md) already
refuses a shared `types` module.

### Qualifier-first file names

Use names such as `failed_claim.rs` or `read_options.rs`. Rejected because they scatter an owner's
files in sorted listings, and the reader must guess the word order.
