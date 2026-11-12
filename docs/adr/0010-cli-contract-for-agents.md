# ADR 0010: The CLI for agents is non-interactive and matches the desktop app

**Date**: 2026-11-04\
**Status**: Accepted\
**Related**: [ADR 0002 (Native Rust app with GPUI, as two binaries over one core crate)](./0002-native-rust-gpui-two-binaries.md),
[ADR 0025 (`tikk needs` holds the attention query)](./0025-needs-holds-the-attention-query.md)

## Context

Agents are the main writers and readers of tickets. An agent works through commands and text output.
It cannot press keys in a window or read what the window draws, and it cannot answer a prompt.

The user works in the desktop app. A feature that only the desktop app can reach is easy to ship and
hard to cover later, because each gap is small and nothing reports it.

## Decision

Every `tikk` command has `--json` and never prompts. Agents reach tikk only through `tikk ...
--json`. The CLI and the desktop app share the core crate, so each action runs the same code in
both.

### Commands

- Every value a prompt would ask for is an argument. A command never waits for input.
- `--json` is a global flag. Without it, a command prints short text.
- Agent skills and tools call `tikk ... --json` and never read or write the store files.

### Output and exit codes

- With `--json`, success prints the bare result object on standard output, such as
  `{"store":"/path","created":true}`. Nothing else goes to standard output.
- With `--json`, a failure prints nothing on standard output and one error object on standard error:
  `{"error":{"code":"notInitialized","message":"..."}}`. The `code` is a stable camelCase name
  that a program branches on. The `message` is for people and may change. An error may add fields
  beside `code` and `message`.
- Exit codes: 0 for success, 1 when tikk refuses the action, and 2 for wrong usage.
- Wrong usage, such as an unknown flag or a bad argument value, has the code `invalidArguments`.
  A missing store has the code `notInitialized`.
- `tikk --help` and `tikk --version` exit with 0. `tikk --version --json` prints
  `{"version":"<version>"}`.

### Desktop and CLI parity

- A change that adds or changes a desktop action adds or changes its CLI command in the same change.
- What the desktop app shows, the CLI can read. The "needs you" list comes from `tikk needs --json`.
- A gesture that only chooses or points needs no CLI equal. The action it leads to does.
- Editing a ticket is `tikk edit <id>` in the CLI, and the desktop app's edit action. Both start
  `$EDITOR` on the ticket file. Neither edits ticket text itself.
- `tikk open` starts the desktop app.

## Consequences

### Positive

- An agent can do anything the user can do in the desktop app, from any shell.
- Scripts and tests drive tikk without a window.
- Agents need no knowledge of the store layout.

### Negative

- Every desktop action takes more work, because it needs a command, its arguments, and its output.
- The commands and their JSON form are a public surface that agents and scripts depend on, so a
  change to them breaks callers.

## Alternatives considered

### CLI commands when someone needs them

Build features for the desktop app first, and add CLI commands when someone needs them. Rejected
because the CLI falls behind, and an agent finds the gap only when it gets stuck.

### Agents drive the desktop app

Let agents send keys and read the screen. Rejected because it depends on shortcuts and layout, which
change often, and it breaks without a clear error.

### Commands that prompt

Ask for missing values in the terminal. Rejected because an agent cannot answer a prompt and would
hang.

### Agents read the store files

Let agents parse tickets and facts themselves. Rejected because it couples agents to the store
layout and repeats the parsing in each caller.
