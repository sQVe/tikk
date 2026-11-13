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
- The caller's identity is the one exception, and it comes from the environment. `TIKK_AGENT`
  names the agent, `TIKK_SESSION` its session, and `TIKK_SESSION_LOG` the path of the session's
  log. tikk reads them once per command, and an empty value counts as unset. Without
  `TIKK_AGENT`, the caller is a person. A command that needs an agent, such as `tikk claim`, exits
  with 1 and the code `noTikkAgent`.
- `--json` is a global flag. Without it, a command prints short text.
- Agent skills and tools call `tikk ... --json` and never read or write the store files.

### Output and exit codes

- With `--json`, success prints the bare result object on standard output, such as
  `{"store":"/path","created":true}`. Nothing else goes to standard output.
- With `--json`, a failure prints nothing on standard output and one error object on standard error:
  `{"error":{"code":"notInitialized","message":"..."}}`. The `code` is a stable camelCase name
  that a program branches on. The `message` is for people and may change. An error may add fields
  beside `code` and `message`.
- An error that names files lists them in `files` beside `code`. A sync conflict, for example, is
  `{"error":{"code":"conflict","files":["tickets/<project>/<file>"],"message":"..."}}`.
- `tikk sync --json` prints `committed`, `committedPaths`, `pending` with each file's `path` and
  `reason`, `fetched`, `merged`, `pushed`, and `problems`. A failed fetch or push is a result, not
  a refusal: sync exits with 0, sets `fetched` or `pushed` to false, and names the step and the
  failure under `problems`.
- Exit codes: 0 for success, 1 when tikk refuses the action, and 2 for wrong usage.
- Wrong usage, such as an unknown flag or a bad argument value, has the code `invalidArguments`.
  A missing store has the code `notInitialized`.
- `tikk --help` and `tikk --version` exit with 0. `tikk --version --json` prints
  `{"version":"<version>"}`.
- `tikk completions <shell> --json` prints `{"script":"<script>"}`. The shell's callback with
  `COMPLETE` set prints candidates in the shell's own format, not JSON. See [ADR
  0034](./0034-shell-completion-calls-back-into-tikk.md).

### Desktop and CLI parity

- A change that adds or changes a desktop action adds or changes its CLI command in the same change.
- What the desktop app shows, the CLI can read. The "needs you" list comes from `tikk needs --json`.
- A gesture that only chooses or points needs no CLI equal. The action it leads to does.
- Editing a ticket is `tikk edit <id>` in the CLI, and the desktop app's edit action. Both start
  `$EDITOR` on the ticket file. Neither edits ticket text itself.
- An agent changes a ticket with `tikk write <id> --file <path> --hash <hash>`. It takes the
  `document` and `hash` of `tikk show --json`, changes that text, and writes it back. tikk refuses
  the write with `changedOnDisk` when the file no longer has that hash. A write therefore never
  replaces a change made by another tikk command, or a change saved before tikk checks the hash.
  A program outside tikk, such as an editor, takes no lock, and a rename cannot compare and swap.
  So a save by such a program in the instant between the check and the rename can still be lost.
  An agent never builds the front matter from other JSON fields.
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

### Identity as arguments

Pass the agent and its session as flags, such as `--agent`, on each command. Rejected because the
program that starts an agent sets its environment once for every command. With flags, the agent
would have to repeat them on each call, and a call that forgot one would act as a person.

### Commands that prompt

Ask for missing values in the terminal. Rejected because an agent cannot answer a prompt and would
hang.

### Agents read the store files

Let agents parse tickets and facts themselves. Rejected because it couples agents to the store
layout and repeats the parsing in each caller.
