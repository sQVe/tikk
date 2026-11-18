# ADR 0035: tikk lists its capability modules in `stomme.toml`

**Date**: 2026-11-18\
**Status**: Accepted\
**Supersedes**: ADR 0006 (Capability modules with an enforced dependency table)\
**Related**: [Shared ADR 0002 (Capability modules with a project-owned import table)](../stomme/shared/adr/0002-capability-modules.md), [Shared ADR 0010 (Recorded violations)](../stomme/shared/adr/0010-recorded-violations.md)

## Context

Shared ADR 0002 asks a project to name its capability modules and the directions between them in one
table, so every agent gets the same answer to where a shared file belongs and which module may use
it. The shared ADR cannot name tikk's modules, so tikk must.

tikk keeps no cache, so every read and write goes through the store files. The CLI and the desktop
app run the same core code for each action, as [ADR 0010](./0010-cli-contract-for-agents.md)
requires, so both need the same door into the core crate.

`stomme check` reads the table from `stomme.toml`. A second table in a local check would have to
match it by hand.

## Decision

tikk lists its capability modules in the `[modules]` table of `stomme.toml`, with one row per module
and one entry in `imports` per allowed edge. `stomme check` refuses an import that crosses the
table.

### Modules

- `fact`, `store`, and `ticket` are modules in `tikk-core`.
- `ticket` and `fact` hold pure rules. `ticket` holds the ticket model, and `fact` holds fact lines
  and the states derived from them.
- `store` does the I/O: the store files, the lock, Git, `gh`, and the clock. It is private to
  `tikk-core`.
- `kit`, `parts`, `scenes`, and `theme` are modules in `tikk-ui`.
- `tikk-cli`, `tikk-desktop`, and `xtask` have no rows.

### Edges

- `fact` uses `ticket`.
- `store` uses `fact` and `ticket`.
- `ticket` uses no module.
- `kit` uses `theme`.
- `parts` uses `kit` and `theme`.
- `scenes` uses `parts` and `theme`.
- `theme` uses no module.

No row imports `store`, so no module uses the I/O module. An edge that keeps these directions is a
table edit. An edge that reverses one needs a new ADR.

### Crates

The CLI and the desktop app use only the public API of `tikk-core`. The core crate keeps its modules
private and exposes the API from its crate root, so neither binary reaches the store directly.

### Known gaps

- stomme does not enforce `pure-std-io`. A pure module could reach I/O through `std`, such as
  `std::fs`. The `clippy.toml` ban on `std::time::SystemTime::now` covers the clock only.
- `gpui-component-kit` reads direct dependencies only. `tikk-ui` reaches gpui-component through the
  `gpui-kit` bundle crate, so the rule cannot see which module uses a component.
  [ADR 0003](./0003-vendored-gpui-component.md) states that boundary, and review holds it.

### Recorded violations

`stomme.toml` records the breaks tikk had when it adopted the shared rules: the `tikk-desktop`
folder name, a `mod.rs` test support file, the separate test files in the store folder, and the
`tikk-scene` binary's file name. Follow-up PRs remove them. The list may only shrink.

## Consequences

### Positive

- One table answers where shared code belongs and which module may use it.
- The check refuses an import that crosses the table, so the structure does not rely on review.
- The recorded breaks are visible and bounded instead of silent exceptions.

### Negative

- Every new module or edge needs a table change, which adds a step to small additions.
- I/O through `std` in a pure module and component use behind `gpui-kit` stay unchecked.
- The table carries the recorded breaks until the follow-ups land.

## Alternatives considered

### Keep the table in a local `xtask` check

Keep tikk's own module check beside `stomme check`. Rejected because two tables of the same modules
drift apart, and each fix must be made twice.

### One crate per capability

Give each capability its own crate and let Cargo's dependency graph hold the edges. Rejected because
`tikk-core` and `tikk-ui` each hold several capabilities that change together, and extra crates add
build targets without adding a boundary the check can read.
