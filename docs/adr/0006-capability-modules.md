# ADR 0006: Capability modules with an enforced import table

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0007 (Side effects as narrow function records)](./0007-side-effect-function-records.md),
[ADR 0008 (One owner for terminal lifetime)](./0008-terminal-lifetime-owner.md),
[lazygit PR #2519](https://github.com/jesseduffield/lazygit/pull/2519)

## Context

tikk reads and writes ticket files, appends facts, keeps a cache, syncs a Git store, parses a CLI,
and renders a TUI. Each job needs one clear owner before app code exists.

Surveys of mature TUIs suggested layer folders such as `domain/`, `application/`, and `adapters/`.
In Tau, generic layers and early shared extraction became scaffolding that later had to be removed.

Separate files alone did not constrain state access in lazygit, whose refactor PR #2519 says "it's
not clear where state should live".

Written rules alone did not hold in Tau: it grew four task-ID parsers despite a parse-once rule.
Boundaries need a mechanical check.

Mergit and Koja use the same approach.

## Decision

`src/` holds capability modules. A lint rule enforces which module may import which. Modules name
their owner, and lint refuses imports that cross the table.

### Modules

- A folder module has one public entry file named after the folder, such as `cache/cache.ts`. Other
  files in the folder are private to the module.
- A flat module is one file. A new module starts as a flat file. It becomes a folder when it needs a
  second source file.
- A file outside the modules is an error.
- tikk has no code yet. The design implies these modules as an expected start: ticket model, facts,
  store and sync, cache, CLI, and TUI. The first change that adds code sets the exact list and the
  table.

### Import direction

- Modules that hold pure rules, such as the ticket model and derived state, import no I/O module and
  no Node or Bun built-ins.
- I/O modules import the model, not each other, and reach each other through injected functions
  ([ADR 0007](./0007-side-effect-function-records.md)).
- The CLI and the TUI import the model and the queries. Neither imports a store or sync module
  directly.
- The TUI imports no Node or Bun built-ins. Only the module that owns the terminal imports OpenTUI
  setup ([ADR 0008](./0008-terminal-lifetime-owner.md)).
- Type imports count as dependencies. Dynamic imports must use a literal path.

A change that keeps these directions updates the rule. A new module joins the table with the ADR or
change that introduces it. A change that reverses a direction needs a new ADR.

### Code placement

- Types live in the module that owns them. Do not add a shared `types.ts`, `utils/`, or barrel file.
- Extract shared code only when two existing consumers need it.

## Consequences

### Positive

- An agent or reviewer can read ownership from the path, and lint refuses imports that cross it.
- Pure modules stay free of I/O, so tests run them without fakes.

### Negative

- Every new module or edge needs a rule change, which adds friction to small additions.
- The rule checks import paths only. It does not detect I/O reached through globals such as
  `Date.now` or `process`.

## Alternatives considered

### Layer folders

Use layer folders (`domain/`, `application/`, `adapters/`, `ui/`). Rejected because the folder names
say little about who owns a job, and they invite empty scaffolding.

### Import rules written only in `AGENTS.md`

Use capability modules with import rules written only in `AGENTS.md`. Rejected because the rules
would drift without a check.
