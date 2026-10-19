# ADR 0010: The CLI contract for agents

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0002 (Own repository on the shared project base)](./0002-shared-project-base.md),
[ADR 0025 (`tikk needs` holds the attention query)](./0025-needs-holds-the-attention-query.md)

## Context

Agents are the main writers and readers of tickets. An agent works through commands and text output.
It cannot press keys in the TUI or read what the TUI draws, and it cannot answer a prompt.

Tau calls tikk across a repository boundary ([ADR 0002](./0002-shared-project-base.md)). A feature
that only the TUI can reach is easy to ship and hard to cover later, because each gap is small and
nothing reports it.

Koja makes the same rule for its UI and CLI.

## Decision

Every tikk command has `--json` and never prompts. Tau reaches tikk only through `tikk ... --json`.
Every action a user can take in the TUI has a CLI equal.

### Commands

- Every value a prompt would ask for is an argument. A command never waits for input.
- `--json` output is a form a program can parse. An expected failure exits with a nonzero code and
  an error message.
- Tau skills and tools call `tikk ... --json` and never read or write the store files.

### TUI and CLI equal

- A change that adds or changes a TUI action adds or changes its CLI command in the same change.
- What the TUI shows, the CLI can read. The "needs you" view comes from `tikk needs --json`.
- A gesture that only chooses or points needs no CLI equal. The action it leads to does.
- `e` opens a ticket in `$EDITOR`, and the CLI has `edit` for the same ticket.

## Consequences

### Positive

- An agent can do anything a user can do in the TUI, from any shell.
- Scripts and tests drive tikk without a TUI.
- Tau needs no knowledge of the store layout.

### Negative

- Every TUI action takes more work, because it needs a command, its arguments, and its output.
- The commands and their JSON form are a public surface that Tau and scripts depend on, so changing
  them breaks callers.

## Alternatives considered

### CLI commands when someone needs them

Build features for the TUI first, and add CLI commands when someone needs them. Rejected because the
CLI falls behind, and an agent finds the gap only when it gets stuck.

### Agents drive the TUI

Let agents drive the TUI by sending keys and reading the screen. Rejected because it depends on key
bindings and layout, which change often, and breaks without a clear error.

### Commands that prompt

Ask for missing values in the terminal. Rejected because an agent cannot answer a prompt and would
hang.

### Tau reads the store files

Let Tau parse tickets and facts itself. Rejected because it would couple Tau to the store layout and
repeat the parsing in two places.
