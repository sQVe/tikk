# ADR 0008: One owner for the desktop app's lifetime

**Date**: 2026-11-04\
**Status**: Accepted\
**Related**: [ADR 0002 (Native Rust app with GPUI, as two binaries over one core crate)](./0002-native-rust-gpui-two-binaries.md),
[GPUI guide](../stomme/layers/gpui/guide.md)

## Context

The desktop app starts a GPUI application, windows, background tasks, and child processes. Each exit
path must stop tasks and children and finish pending writes. The user can close the last window or
quit with a shortcut, and each path must clean up the same way.

## Decision

The GPUI guide's `gpui-app-lifetime` rule is the base: one module of the desktop app owns the GPUI
application, its windows, the action and key registration, background tasks, and shutdown. The
entry point composes dependencies and starts that module. Quit, the last window closing, and a
system quit request run the same shutdown path once. tikk adds the shutdown steps and the editor
rules below.

### Shutdown

- The shutdown path stops new work and cancels running tasks and owned child processes. It waits a
  bounded time for children to exit, then ends the rest.
- It finishes pending writes under the store lock before the process exits.
- A fatal error shows the user a message before the process exits.

### Editing

- Editing a ticket starts `$EDITOR` on the ticket file as a child process. The desktop app does not
  borrow or suspend a terminal, and it edits no ticket text itself.
- The owner tracks that child process, so shutdown ends it.

## Consequences

### Positive

- Every exit path runs the same cleanup in the same order.
- Actions start the editor without knowing about the windows.

### Negative

- A bounded wait can cut off a slow child process at quit.
- The app cannot choose where the editor opens. It depends on the user's `$EDITOR` and desktop
  setup.

## Alternatives considered

### Component-owned exits

Let each window or task handle its own exit. Rejected because exit paths would compete, and one
could skip cleanup.

### Require a terminal multiplexer for the editor

Start `$EDITOR` only in a separate multiplexer pane. Rejected because tikk must work without one.
