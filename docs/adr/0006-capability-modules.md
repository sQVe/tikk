# ADR 0006: Capability modules with an enforced dependency table

**Date**: 2026-11-04\
**Status**: Accepted\
**Related**: [ADR 0007 (Side effects as narrow records of functions)](./0007-side-effect-function-records.md),
[ADR 0008 (One owner for the desktop app's lifetime)](./0008-app-lifetime-owner.md)

## Context

tikk reads and writes ticket files, appends facts, keeps a cache, syncs a Git store, parses a CLI,
and draws a desktop window. Each job needs one clear owner before app code exists.

Folders such as `domain/`, `application/`, and `adapters/` describe layers, but they do not say who
owns a job. Separate files alone do not limit which code reads state. Written rules alone do not
hold: a rule that is only in prose drifts as code grows. Boundaries need a mechanical check.

## Decision

tikk splits code into capability modules. A check in the `xtask` crate enforces which module may use
which. The check refuses any use that crosses the table.

### Modules

- A folder module has one entry file named after the folder, such as `cache.rs` beside `cache/`.
  Other files in the folder are private to the module.
- A flat module is one file. A new module starts as one file. It becomes a folder when it needs a
  second file.
- The table lists each module and the modules it may use. It lives in the `xtask` crate.

### Dependency direction

- Modules that hold pure rules, such as the ticket model and derived state, use no I/O module and no
  I/O from `std`. They do not depend on GPUI.
- I/O modules use the model, not each other. They reach each other through functions passed in, as
  [ADR 0007](./0007-side-effect-function-records.md) describes.
- The CLI and the desktop app use only the public API of the core crate. The store and sync modules
  are private to the core crate.
- Only the desktop app uses GPUI and gpui-component.

A change that keeps these directions updates the table. A change that reverses a direction needs a
new ADR.

### Code placement

- Types live in the module that owns them. Do not add a shared `types`, `utils`, or re-export-only
  module.
- Extract shared code only when two existing consumers need it.

## Consequences

### Positive

- A reader finds ownership from the path, and the check refuses an import that crosses the table.
- Pure modules run in tests without fakes.

### Negative

- Every new module or edge needs a table change, which adds friction to small additions.
- The check reads `use` paths and crate dependencies only. It does not detect I/O reached through
  `std` calls such as `std::time::SystemTime::now`.

## Alternatives considered

### Layer folders

Use layer folders such as `domain/`, `application/`, `adapters/`, and `ui/`. Rejected because the
folder names say little about who owns a job, and they invite empty scaffolding.

### Import rules written only in docs

Keep the import rules in the docs with no check. Rejected because the rules would drift without a
check.

### One crate for everything

Put the CLI and the desktop app in the core crate. Rejected because the CLI would then build the
GPUI dependencies, as [ADR 0002](./0002-native-rust-gpui-two-binaries.md) rules out.
