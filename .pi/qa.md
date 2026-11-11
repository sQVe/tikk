# QA guide

tikk ships `tikk`, a command line for agents and the user, and `tikk-desktop`, a desktop app. Today
`tikk` has only `--help`, and `tikk-desktop` is a stub. A mock scene of the UI opens in the scene
window, in the ruta sandbox.

## Choose sections

| Section      | Test it when the change touches                                                     |
| ------------ | ----------------------------------------------------------------------------------- |
| CLI          | A command, flag, output, exit code, environment variable, or any `tikk-core` module |
| Scene window | A scene, a part, or the theme in `crates/tikk-ui`; `tikk-scene.rs`                  |

Cross-effects:

- `tikk-core` holds every rule. A change there needs the CLI section, even when no file in
  `tikk-cli` changed.
- `vendor/gpui-component`, the `gpui-kit` version, `Cargo.lock`, and `rust-toolchain.toml` can
  change how every scene draws. They need the Scene window section.
- `ruta.toml` and the ruta release set the window size and how the sandbox finds the window. They
  need the Scene window section.

Pick the scenes. `SceneName` in `crates/tikk-ui/src/scenes.rs` lists them.

- A change to one scene: that scene.
- A change to a part in `crates/tikk-ui/src/parts.rs`: every scene that uses the part.
- Any other change to the Scene window section: `placeholder`.

- A change to `xtask`, CI, or docs needs no `qa` launch. A change to this guide needs the section
  it changes.
- A new mock's look needs no `qa` launch. The [judge-mock skill](skills/judge-mock/SKILL.md) gates
  it from still images.
- A change to only `tikk-desktop` falls under "Not testable".
- When the impact on a section is unclear, include the section.

## Before a launch

For the manager. The `qa` worker cannot build or start anything, and one sandbox shows one scene.
For the Scene window section, run `RUTA_NAME=<name> ruta guide` and follow its rules for the
session that starts the sandbox.

The manager starts:

- For the CLI section, the build: `cargo build --locked` in the worktree. It is done when the
  `find` command under "Reach it" prints nothing. It ends by itself, so it has no stop command.
- For the Scene window section, one sandbox for each assigned scene, after the last edit. It reads
  no secret, costs nothing, and keeps to its own folder and private display.

  ```sh
  RUTA_NAME=<name> cargo xtask sandbox up <scene>
  ```

  It is up when `RUTA_NAME=<name> ruta status` exits 0. After the worker reports, stop it:

  ```sh
  RUTA_NAME=<name> ruta down
  ```

Ask the user:

- What `ruta guide` tells the session that starts the sandbox to ask first.

Put in the brief: each `RUTA_NAME` with its scene, and whether the scene handles input. Launch `qa`
without `url`; a native window has none.

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

## Scene window

### Reach it

Run `RUTA_NAME=<name> ruta guide` first, with a `RUTA_NAME` from the brief. Follow its rules for
every session and for a session that did not start the sandbox.

1. Check that the sandbox is up and serves this worktree:

   ```sh
   RUTA_NAME=<name> ruta status
   ```

   `ruta guide` gives the output of a sandbox that is up. The folder in it must be this worktree's
   root. Otherwise ask the parent to start the sandbox.

2. Check that the window runs the current binary:

   ```sh
   pid=$(cut -d' ' -f1 /var/tmp/ruta-<name>/pid)
   readlink /proc/$pid/exe
   ```

   It must print `<worktree root>/target/debug/tikk-scene`. A path that ends in `(deleted)` means
   someone rebuilt the binary after the window opened.

3. Check that no source is newer than the binary, and that `ruta.toml` is not newer than the
   sandbox:

   ```sh
   find crates/tikk-ui vendor/gpui-component Cargo.toml Cargo.lock .cargo/config.toml \
     rust-toolchain.toml -newer target/debug/tikk-scene -type f
   find ruta.toml -newer /var/tmp/ruta-<name>/pid
   ```

   Any path in the output means the window may show old code or old sandbox settings.

4. Check the scene: `RUTA_NAME=<name> ruta log` prints a JSON line whose `scene` is the scene from
   the brief.

If step 2, 3, or 4 fails, report it to the parent and test nothing.

### Use it safely

`ruta guide` lists the commands you may run and the ones you may not. tikk adds these rules:

- Never run `cargo` or `cargo xtask`. They build.
- Never write under `/var/tmp/ruta-*`. Write shots under `/tmp`, with a new name for each shot.
- `ruta log` prints what the app wrote to its output.
- `ruta --help` prints the arguments of each command. It exits 1. Positions are window pixels.

### What to check

- The shot has the width and height that `ruta.toml` sets. `magick identify <file>` prints the
  shot's size.
- The panel is whole: no border, row, or label is cut off. Empty space below the last row is
  normal.
- Text is readable, and no label overlaps another.
- When the brief says the scene handles no input, a shot after a click, a key, and a scroll is the
  same picture as before. `magick compare -metric AE <before> <after> null:` then prints `0 (0)`.
- The `placeholder` scene proves only that the sandbox and the capture run. It has no design to
  judge.

## Not testable

Report each of these as not verified. Do not try one through another path.

- The desktop app, and what it shows of a `tikk-core` query. `tikk-desktop` is a stub with an
  empty `main`, and `cargo build --locked` does not build it.
- Other window sizes: the sandbox has the one size that `ruta.toml` sets.
- macOS and GPUI's Wayland backend: the sandbox runs GPUI's X11 backend on Linux.
- `cargo xtask`: it runs only through `cargo`, which builds. The manager runs `cargo xtask check`.

[The development guide](../docs/development.md#sandbox) holds the install steps, the system
requirements, and examples of the sandbox commands.
