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
- Each local patch is recorded next to the vendored code, with what it changes and why, so the patch
  can be kept on an update.
- tikk offers generic patches upstream, but does not wait for them.

### One boundary

- One module of the desktop app imports gpui-component. It is the kit module.
- Other code uses tikk's own types for widgets, themes, and events. The kit module translates
  between the two.
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
