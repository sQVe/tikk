# ADR 0004: OpenTUI with React for the TUI

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0003 (Bun as runtime, package manager, test runner, and compiler)](./0003-bun-toolchain.md),
[OpenTUI scroll box](https://opentui.com/docs/components/scrollbox/),
[OpenTUI keymap](https://opentui.com/docs/keymap/overview/),
[OpenTUI testing](https://opentui.com/docs/core-concepts/testing/)

## Context

The user wants a TUI that opens on a "needs you" view, with a tree view second. It needs scrolling
lists, focus, configurable shortcuts, and resize handling.

Zeta and Phi render with OpenTUI and its React bindings on Bun. The problems they found are in
OpenTUI's core, so they apply to every OpenTUI binding. tikk shares the same renderer and avoids the
same problems.

## Decision

tikk renders its TUI with OpenTUI and its React bindings, on Bun. The TUI reads state from the
`tikk needs` query and the cache. It runs actions such as close, accept, cancel, and archive through
the same code as their CLI commands ([ADR 0010](./0010-cli-contract.md)). It edits no ticket text;
`e` opens the ticket in `$EDITOR`.

### Shortcuts

- Shortcuts come from one keymap definition, registered through `@opentui/keymap`. Components do not
  hard-code keys.
- A focused scroll box scrolls on its own keys, outside the keymap. Every scroll box must call
  `preventDefault()` in its `onKeyDown` handler, so the keymap stays the only source of shortcuts.

### Layout

Code that reacts to a scroll box resize listens to the `resize` event of `scrollBox.viewport`. The
scroll box's `onSizeChange` runs before its viewport has the new size.

### Tests

UI tests use OpenTUI's headless test renderer and mock input, and wrap input and renders in React's
`act`.

## Consequences

### Positive

- One React model for state and rendering, with headless tests that press keys and read frames.
- tikk, Zeta, and Phi share one UI stack, so a fix moves between them.

### Negative

- OpenTUI is young and changes often. Upgrades need the tests to catch behavior changes.
- Every scroll box needs the key guard. A missing guard lets removed shortcuts keep working.
- React's `act` rules apply to every UI test.

## Alternatives considered

### Ink

Use Ink. Rejected because Zeta's library comparison chose OpenTUI over it, and tikk follows that
choice to stay on the shared base.

### OpenTUI with Solid bindings

Use OpenTUI with Solid bindings. Rejected because the project prefers React, and the core problems
would remain.

### OpenTUI Core API without bindings

Use the OpenTUI Core API without bindings. Rejected because the app would update lists and previews
from state by hand.
