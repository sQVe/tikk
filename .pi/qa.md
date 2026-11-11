# QA guide

tikk ships `tikk`, a command line for agents and the user, and `tikk-desktop`, a desktop app. Today
`tikk` has only `--help`, and `tikk-desktop` opens no window.

## Choose sections

| Section | Test it when the change touches                                                     |
| ------- | ----------------------------------------------------------------------------------- |
| CLI     | A command, flag, output, exit code, environment variable, or any `tikk-core` module |

Cross-effects:

- `tikk-core` holds every rule. A change there needs the CLI section, even when no file in
  `tikk-cli` changed.

- A change to `xtask`, CI, or docs needs no `qa` launch. A change to this guide needs the section
  it changes.
- A change to only `tikk-ui` or `tikk-desktop` falls under "Not testable".
- When the impact on a section is unclear, include the section.

## Before a launch

For the CLI section, run `cargo build --locked` in the worktree.

## Rules for every section

Never:

- Run `tikk` from `PATH`. It can be another program.
- Read or change `~/.local/share/tikk`. It is the user's store.

## CLI

### Reach it

- The binary is `target/debug/tikk`. Run every command from the worktree root.
- The binary is not older than its sources when this command prints nothing:

  ```sh
  find crates Cargo.toml Cargo.lock .cargo/config.toml rust-toolchain.toml -newer target/debug/tikk -type f
  ```

- If the binary is missing or the command prints a file, stop and ask the parent to run
  `cargo build --locked` in the worktree.

### What to check

`target/debug/tikk --help` exits with 0 and prints "A local ticket tracker for AI agents" and the
usage.

## Not testable

- The desktop app, and what it shows of a `tikk-core` query. `target/debug/tikk-desktop` exits
  with 0 and opens no window.
