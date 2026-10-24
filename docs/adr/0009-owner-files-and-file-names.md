# ADR 0009: Owner files inside modules, thin coordinators, and owner-first file names

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0006 (Capability modules with an enforced import table)](./0006-capability-modules.md),
[ADR 0005 (Results for expected failures, exceptions for bugs, and zod at boundaries)](./0005-results-exceptions-and-zod-boundaries.md)

## Context

[ADR 0006](./0006-capability-modules.md) decides which modules exist and which may import which. It
says nothing about how code is arranged inside a module. Without a rule, features go into a few
central files.

Agents write most features as slices that run in parallel branches. When every slice edits the same
central file, the branches conflict there, and a reader must scan one long file to find one feature.
The conflicts come from shared editing paths, not from size.

Mergit and Koja follow the same rule, so an agent that works in all three finds code the same way.

## Decision

Inside each folder module, code for one owner lives in private files named owner first, and the
module's coordinators hold only dispatch, lifecycle, and the order that must stay central. Size is a
reason to review a file, never a check that fails.

### Owners

- An owner is a user-facing noun for behavior that changes on its own, whether an entity or a
  capability. Use the same noun for it in every module, so its CLI, cache, and UI files share a
  prefix.
- Infrastructure that belongs to no feature has its own owner noun, such as `lock` or `clock`.
- An owner may have several files, one per behavior that changes on its own, such as parsing,
  transitions, and effects. Keep a resource's lifetime or one state machine in one file.
- Extract shared code when two existing consumers need it.

### Coordinators

- A coordinator dispatches to owner files and keeps the order that must stay central. It holds no
  owner-specific behavior.
- A feature edits a coordinator only to register a command, an intent, or a layout slot, or to
  change a public contract. Keep those edits small and explicit.
- Entry files stay the public API that ADR 0006 defines.

### File names

- Name a private file `<owner><job>` in camelCase, with a singular owner noun first, such as
  `claimTransitions.ts` or `ticketParse.ts`.
- A file may use the owner noun alone when that noun names what the file holds. A plural noun alone
  names a collection.
- A component file keeps PascalCase after the component it exports and starts with its owner.
- Functions start with a verb and types use PascalCase. The owner-first order applies to file names
  only.

### Tests

- A test file keeps its source name with `.test`, so a split source file splits its tests.
- Move setup into a private harness only when two suites share it. A harness imports no `bun:test`,
  returns its cleanup, and holds no resource shared across suites. Setup shared across modules lives
  in `tests/`. Fixtures stay in the suite that uses them.
- An integration test in `tests/` is named for its owner and behavior.

### Size

- Review a file over 500 lines and a function over 60 lines or with more than 4 parameters. Split by
  responsibility, not to meet a count.
- These limits are review signals. No check fails on them.

## Consequences

### Positive

- Parallel slices for different owners edit different files, so they conflict less.
- A reader finds a feature by its noun: sorted listings group `claim*` files together in each
  module.
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

### A hard line limit in lint

Let lint refuse files over 500 lines. Rejected because a count does not show ownership: it would
force splits of cohesive files, while a coordinator under the limit could still hold every feature.
Lint that fails on warnings would block a warning level too.

### One folder per feature across modules

A folder per feature holding its store, CLI, and UI code. Rejected because it breaks the capability
modules of ADR 0006: pure and UI code would share a folder, and the import table could no longer
tell them apart.

### Split by kind of code

Files such as `types.ts`, `handlers.ts`, and `parsers.ts` inside each module. Rejected because one
feature would spread across every file, and ADR 0006 already refuses a shared `types.ts`.

### Qualifier-first file names

Names such as `failedClaim.ts` or `readOptions.ts`. Rejected because they scatter an owner's files
in sorted listings, and the reader must guess the word order.
