# ADR 0002: Native Rust app with GPUI, as two binaries over one core crate

**Date**: 2026-11-04\
**Status**: Accepted\
**Related**: [ADR 0003 (Vendored gpui-component and patch boundary)](./0003-vendored-gpui-component.md),
[ADR 0010 (The CLI contract for agents)](./0010-cli-contract-for-agents.md)

## Context

tikk has two kinds of user. The user needs a window with the attention view and the ticket tree.
Agents need a command line that starts fast and works with no display. One program cannot serve both
well if the command line must load a GUI library.

tikk ships as a standalone program. A user should install it and run it with no runtime to set up.

## Decision

tikk is a native Rust app on GPUI and gpui-component, built as two binaries. Both use one shared
core crate that holds the ticket model, storage, and actions. The two binaries are `tikk`, the
agent CLI, which does not depend on GPUI, and `tikk-desktop`, the desktop app. `tikk open` starts
it.

The core crate never depends on GPUI, so its tests run without a display or GPU.

The split follows from three reasons. Agents start the CLI often, and loading GPUI and its display
libraries would add cost to each call. Headless machines have no display libraries, and the CLI must
still run there. CLI tests run without GPUI, so they build and pass on any machine. Each binary is a
native executable with no runtime to install.

## Consequences

### Positive

- The CLI starts fast and runs on headless machines.
- CLI tests need no display, GPU, or GPUI build.
- One core crate holds the rules, so the CLI and the desktop app cannot disagree.

### Negative

- Two binaries must be built, released, and versioned together.
- Some behavior exists only in the desktop app, and only the desktop tests can reach it.
- Building the desktop app on Linux needs system libraries for fonts, windowing, and the GPU.
- The desktop app runs only as a desktop program. It cannot be served to a browser or another
  machine.

## Alternatives considered

### One binary with a desktop subcommand

Start the desktop app from the same `tikk` binary, as a subcommand. Rejected because every agent
call would load GPUI and its display libraries, and the CLI would fail on headless machines.

### A local web app

Serve the UI from a local server and open it in a browser. Rejected because every view would cross a
server and a browser, and the app would need a second runtime to run the server.

### Keep the Bun, TypeScript, and OpenTUI app

Keep the terminal app on the Bun runtime. Rejected because the native runtime needs no second
language, and the desktop window can show the attention view that a terminal cannot show well.
