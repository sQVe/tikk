# ADR 0003: Vendored gpui-component with a recorded patch boundary

**Date**: 2026-11-04\
**Status**: Accepted\
**Related**: [ADR 0002 (Native Rust app with GPUI, as two binaries over one core crate)](./0002-native-rust-gpui-two-binaries.md)

## Context

The desktop app needs widgets such as buttons, lists, inputs, and layout parts. GPUI does not
provide them. gpui-component provides them, but it is pre-1.0, so its API can change between
releases.

tikk may need fixes that upstream does not accept on its own schedule. A stock crate cannot carry
those fixes.

## Decision

tikk builds its widgets on gpui-component, from a vendored copy that tikk owns and patches. tikk
treats the vendored copy as its own code.

### Vendored copy

- The vendored copy keeps gpui-component's Apache-2.0 license and notices.
- `vendor/gpui-component/PATCHES.md` records the published source and each local patch, with its
  reason. Each patch starts with a `// TIKK:` marker so it can be found and kept on an update.
- Cargo uses the vendored copy through `[patch.crates-io]`. The vendor tree is not a workspace
  member and is excluded from project formatting, spelling, and mutation checks.
- tikk offers generic patches upstream, but does not wait for them.

### One boundary

- `tikk-ui` owns the kit module. Only that module imports gpui-component, through
  `gpui_kit::component`. Both mock scenes and future desktop views use this boundary.
- Other code uses tikk's own types for widgets, themes, and events. The kit module translates
  between those types and component types. GPUI layout and rendering types may be used throughout
  `tikk-ui` through `gpui-kit`.
- A switch to a fork or a different kit then changes that module only.

## Consequences

### Positive

- The desktop app gets the parts of a kit without building them.
- Patches stay small and recorded, so the owner of each change is clear.
- Kit types do not spread through the desktop code.

### Negative

- Every gpui-component update must carry tikk's patches forward.
- GPUI and gpui-component are pre-1.0, so updates can break their API.
- The kit module adds translation code.

## Alternatives considered

### Stock gpui-component without a vendored copy

Use the published crate and wait for upstream fixes. Rejected because a stock crate cannot carry a
local fix, and upstream may not accept a patch that tikk needs.

### Custom widgets on GPUI alone

Build every widget on GPUI, with no kit. Deferred because it rebuilds parts the kit already has. It
stays the fallback if the kit cannot meet a later need.
