# QA guide

tikk ships `tikk`, a command line for agents and the user, and `tikk-desktop`, a desktop app. Today
`tikk` has only `--help`, and `tikk-desktop` opens no window.

## Choose sections

| Section     | Test it when the change touches                                                     |
| ----------- | ----------------------------------------------------------------------------------- |
| CLI         | A command, flag, output, exit code, environment variable, or any `tikk-core` module |
| Desktop app | `tikk-ui`, `tikk-desktop`, or a `tikk-core` query the app shows                     |

- `tikk-core` holds every rule. A change there needs both sections.
- A change to `xtask`, CI, or docs needs no section.
- When the impact on a section is unclear, include the section.

## CLI

### Reach it

- Run `target/debug/tikk` from the worktree root. `tikk` on `PATH` can be another program.
- The binary is not older than its sources when this command prints nothing:

  ```sh
  find crates Cargo.toml Cargo.lock .cargo/config.toml rust-toolchain.toml -newer target/debug/tikk -type f
  ```

- If the binary is missing or the command prints a file, ask the parent to run
  `cargo build --locked` in the worktree.

### Use it safely

Never:

- Run `tikk` from `PATH`.
- Read or change `~/.local/share/tikk`. It is the user's store.

### What to check

`target/debug/tikk --help` exits with 0 and prints "A local ticket tracker for AI agents" and the
usage.

### Recipes

None yet.

## Desktop app

`target/debug/tikk-desktop` exits with 0 and opens no window. Report the desktop app as not
testable.
