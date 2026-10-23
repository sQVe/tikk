# ADR 0008: One owner for terminal lifetime

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0004 (OpenTUI with React for the TUI)](./0004-opentui-react-tui.md),
[ADR 0007 (Side effects as narrow function records)](./0007-side-effect-function-records.md)

## Context

The TUI stops on `q`, Ctrl+C, SIGINT, SIGTERM, and fatal errors. Each path must stop timers and
children, finish writes, and restore the terminal.

Surveyed OpenTUI apps work around unsafe teardown: Ox repairs terminal line discipline after
destroy, and Cline defers destroy until input parsing finishes.

`e` opens a ticket in `$EDITOR` ([ADR 0025](./0025-needs-holds-the-attention-query.md)). The editor
runs in tikk's own terminal, so the renderer must pause and resume around a child process.

Only the TUI owns a terminal. CLI commands print and exit, and agents run them with no terminal.

## Decision

One module alone owns the renderer, the keymap instance, React mounting, signal handlers, and
shutdown of the TUI. The entry point composes dependencies and starts that module. One module
controls the renderer's lifetime, every exit path, and every terminal handoff.

### Shutdown

- One idempotent shutdown runs for every exit path. The renderer's own exit handling is turned off.
- It blocks new intents and stops timers, then aborts running work and owned child processes. It
  terminates children that do not exit within a bounded wait.
- It unmounts React, removes bindings and subscriptions, and destroys the renderer in `finally`.
- It restores the terminal before it prints a fatal error.

### Lending the terminal

- The owner provides a function that suspends input and rendering, runs a child process in the
  terminal, and resumes in `finally`. Actions receive it as an injected function.
- If resume fails, tikk restores the terminal and exits.

## Consequences

### Positive

- Every exit path runs the same cleanup in the same order.
- Actions can run interactive tools without knowing about the renderer.

### Negative

- The suspend and resume sequence depends on the pinned OpenTUI version. Pseudo-terminal tests
  verify it: `$EDITOR` reads a line typed into the lent terminal, the TUI resumes, shows the edit,
  and takes keys again. Shutdown during the editor kills it and restores the terminal. An OpenTUI
  upgrade must keep those tests passing.
- Bounded waits can cut off a slow child process at quit.

## Alternatives considered

### Component-owned exits

Let each component or hook handle its own exit. Rejected because exit paths would compete, and one
could skip cleanup.

### Require a multiplexer

Run `$EDITOR` only in a separate multiplexer pane. Rejected because tikk must work without one.
