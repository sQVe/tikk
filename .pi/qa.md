# QA guide

tikk ships `tikk`, a command line for agents and the user, and `tikk-desktop`, a desktop app. Today
`tikk` has `init`, `new`, `show`, `ls`, `write`, `edit`, `done`, `cancel`, `block`, `unblock`,
`move`, `rank`, `claim`, `release`, `ready`, `--help`, and `--version`, and `tikk-desktop` is a
stub. A mock scene of the UI
opens in the scene window, in the ruta sandbox. Every CLI check runs with `TIKK_HOME` set to a fresh
folder under `/tmp`.

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

## Journeys

A journey is one user's path through several commands. Each journey file lists its steps, and its
test runs them against the built binary.

| Journey                                                     | Goal                                                                      | Run it when the change touches                                                     | Test                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [tickets-by-hand](qa/journeys/tickets-by-hand.md)           | Set up a store and keep a plan's to-dos in order.                         | `tikk init`, `new`, `ls`, `cancel`, `rank`, `block`, CLI output                    | `crates/tikk-cli/tests/journey_tickets_by_hand.rs`      |
| [manager-runs-a-slice](qa/journeys/manager-runs-a-slice.md) | Take a slice from ready to done, with no step that marks it done by hand. | `tikk new --file`, `show`, `ready`, `claim`, `done`, ticket validation             | `crates/tikk-cli/tests/journey_manager_runs_a_slice.rs` |
| [trouble](qa/journeys/trouble.md)                           | Each failure is named with what to fix, and no ticket is lost.            | Ticket parsing, error codes, `tikk ls`, `show`, `write`, `release`, the store lock | `crates/tikk-cli/tests/journey_trouble.rs`              |

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
- Read or change `~/.local/share/tikk`. It is the user's store. Set `TIKK_HOME` to a fresh folder
  under `/tmp` for every `tikk` command, such as `export TIKK_HOME=$(mktemp -d /tmp/tikk-qa-XXXX)`.

## CLI

### Reach it

- The binary is `target/debug/tikk`. Run every command from the worktree root.
- The binary is not older than its sources when this command prints nothing:

  ```sh
  find crates Cargo.toml Cargo.lock .cargo/config.toml rust-toolchain.toml -newer target/debug/tikk -type f
  ```

- If the binary is missing or the command prints a file, stop and ask the parent to run
  `cargo build --locked` in the worktree.

### External programs

`tikk init` starts `git` and, without `--machine`, `uname -n` for the host name. `tikk new` without
`--parent` and `--project`, and `tikk ready` without them, start
`git config --get remote.origin.url` in the working directory. All
run from `PATH` with an argument list. `tikk edit` splits `EDITOR` on whitespace into a program
and its arguments. It runs the program with no shell, with those arguments and then the ticket file
path. Without `EDITOR`, or with one that is empty or holds only whitespace, it exits with 1 and
`noEditor`.

### Identity

`TIKK_AGENT` names the agent that runs a command, `TIKK_SESSION` its session, and
`TIKK_SESSION_LOG` the path of the session's log. An empty value counts as unset. Without
`TIKK_AGENT`, the caller is a person. Unset all three before a check that runs as a person.

### What to check

- `target/debug/tikk --help` exits with 0 and prints "A local ticket tracker for AI agents" and the
  usage.
- `target/debug/tikk --version --json` exits with 0 and prints `{"version":"0.0.0"}`.
- `target/debug/tikk init --json` in an empty `TIKK_HOME` exits with 0 and prints
  `{"created":true,"store":"<TIKK_HOME>"}`. The folder then holds `tikk.json` with
  `{"version":1}`, `.gitattributes` with `facts/** merge=union`, and one commit on `main`
  (`git -C "$TIKK_HOME" log --oneline main`).
- A second `target/debug/tikk init --json` exits with 0 and prints `"created":false`. Without
  `--json`, it prints "The tikk store already exists at <TIKK_HOME>."
- `target/debug/tikk init --machine laptop` saves `laptop` in `$TIKK_HOME/.git/tikk-machine`.
  Without `--machine`, the file holds the first label of `uname -n`, lowercased.
- `target/debug/tikk init --json` in a `TIKK_HOME` with other files exits with 1, prints nothing on
  standard output, and prints `{"error":{"code":"folderNotEmpty",...}}` on standard error.
- `target/debug/tikk init --json --no-such-flag` exits with 2 and prints
  `{"error":{"code":"invalidArguments",...}}` on standard error. Without `--json`, it prints
  the error and the usage on standard error.
- `target/debug/tikk new <kind> <title> [--parent <id>] [--project <p>]` with the kind `plan`,
  `slice`, `instruction`, or `task` prints the new ID and writes
  `$TIKK_HOME/tickets/<project>/<id>-<slug>.md`. It makes no commit. With `--json`, it prints
  `{"id":...,"path":...}`. From the worktree root, a ticket without `--parent` and `--project` is in
  the project `tikk`, from `origin`. From a folder outside a repository, such as `/tmp`, it is in
  `personal`.
- `target/debug/tikk new --file <path> --json` creates a ticket from a document of the ticket file
  form, such as `---`, `kind: task`, `title: T`, `parent: <slice>`, `---`. A task under a slice
  exits with 1 and prints `{"error":{"code":"invalidTicket","field":"parent",...}}`, and no file is
  written. A slice with `--parent <plan>` and a `--project` that differs from the plan's exits with
  1 and the field `project`.
- `target/debug/tikk show <id> --json` exits with 0 and prints the front matter fields, `path`,
  `hash` (the SHA-256 of the file, which `sha256sum <path>` prints), `body`, `document` (the exact
  text of the file, which `cat <path>` prints), `children` as rows, and `files` of the folder
  `tickets/<project>/<id>/`. Without `--json`, it prints the ticket's row, a `reason:` line and a
  `blockedBy: <id>, <id>` line when the ticket has them, its children's rows indented, and the body.
  An unknown ID exits with 1 and `notFound`, and a malformed ID exits with 2 and `invalidArguments`.
- `target/debug/tikk ls [--project <p>] [--kind <k>] [--parent <id>] [--status <s>]
  [--search <text>] --json` prints `{"errors":[...],"tickets":[...]}`. Each row holds `id`, `title`,
  `kind`, `status`, and `parent`. `--search` matches the title or body without regard to case.
  Without `--json`, it prints `<id>  <kind>  <status>  <parent or ->  <title>` per ticket.
- A ticket file broken by hand, such as one that holds only `kind: [`, appears in
  `target/debug/tikk ls --json` under `errors` with its `path` and `message`, and the other tickets
  stay listed. `target/debug/tikk show <its id> --json` exits with 1 and `parseError`.
- `target/debug/tikk ls --json` with a `TIKK_HOME` that holds no store exits with 1, prints nothing
  on standard output, and prints `{"error":{"code":"notInitialized",...}}` on standard error.
- `target/debug/tikk write <id> --file <path> --hash <hash> --json`, with the `document` and `hash`
  of `tikk show <id> --json` saved unchanged to `<path>`, exits with 0, prints the ticket's row with
  its `path` and `hash`, and leaves the file's bytes as they were. After an edit to the ticket file
  by hand, the same command with the old hash exits with 1 and `changedOnDisk`, and the file keeps
  the hand edit.
- `EDITOR=<script> target/debug/tikk edit <id> --json` runs the script with the ticket file's path
  as its one argument, then prints `{"id":...,"path":...}`. `EDITOR="<script> --wait"` passes
  `--wait` before the path. The command changes no file itself.
- `target/debug/tikk done <id> --json` on a task or an instruction exits with 0 and prints the row
  with the status `done`. On a plan or a slice, it exits with 1 and `wrongKind`, and the message
  names the kind.
- `target/debug/tikk cancel <id> --reason <text> --json` exits with 0, and `tikk show <id> --json`
  then has the status `canceled` and the reason. Without `--reason`, it exits with 2 and
  `invalidArguments`.
- `target/debug/tikk block <id> <blocker> --json` exits with 0 and prints the row of `<id>`, and
  `tikk show <id> --json` then lists `<blocker>` in `blockedBy`. Without `--json`, `tikk show <id>`
  prints the line `blockedBy: <blocker>`. `target/debug/tikk unblock <id> <blocker> --json` exits
  with 0 and empties the list again, also after the blocker's file is deleted. A second `block` of
  the same pair, or an `unblock` of a pair with no edge, exits with 0 and leaves the file as it was.
  An unknown ID or blocker exits with 1 and `notFound`, and so does an `unblock` with no edge to a
  blocker that does not exist.
- After `tikk block A B`, `target/debug/tikk block B A --json` exits with 1 and prints
  `{"error":{"code":"cycle","field":"blockedBy","message":...}}`. The message lists B, A, and B in
  that order. `tikk block <plan> <slice>`, with the slice under the plan, exits with 1 and `cycle`,
  and the message says that the slice "has the parent" the plan. `tikk block <id> <id>` exits with 1
  and `cycle`. A `tikk write` whose `blockedBy` closes a cycle exits with 1 and `cycle`, and the
  file keeps its bytes.
- `target/debug/tikk move <id> --parent <id> --json` and
  `target/debug/tikk move <id> --no-parent --json` exit with 0 and print the row with the new
  `parent`. A move to a new parent clears the ticket's `rank`, and a move to the parent it already
  has exits with 0 and leaves the file as it was. An instruction moved under a plan, a slice moved
  with `--no-parent`, and a parent in another project exit with 1 and
  `{"error":{"code":"invalidTicket","field":"parent",...}}`. Without `--parent` or `--no-parent`, it
  exits with 2.
- `target/debug/tikk rank <id> --first`, `--last`, `--before <id>`, or `--after <id>` exits with 0
  and prints the row. On slices A, B, and C ranked in that order under one plan,
  `tikk rank C --before A`, then `tikk ls --parent <plan> --json` lists C, A, and B, with the ranks
  1, 2, and 3 in `tikk show`. A `--before` or `--after` ticket with another parent exits with 1 and
  `notSibling`, and the message starts with its ID. `tikk rank <id> --before <id>` or `--after <id>`
  with the ticket itself exits with 0 and leaves every file as it was. Without one of the four
  flags, or with two, it exits with 2.
- `TIKK_AGENT=manager TIKK_SESSION=s-1 TIKK_SESSION_LOG=/tmp/log.jsonl target/debug/tikk claim
  <slice> --json` on an open slice with a criterion exits with 0 and prints
  `{"claim":{"agent":"manager","leaseEnd":...,"session":"s-1","sessionLog":"/tmp/log.jsonl","state":"claimed"},"id":...}`.
  The `leaseEnd` is 4 hours after the claim, in UTC to the millisecond. The claim is one line in
  `$TIKK_HOME/facts/<machine>/<yyyy-mm>.jsonl`, with the machine from `.git/tikk-machine`:
  `{"v":1,"kind":"claim","ticket":...,"at":...,"agent":"manager",...}`. A second claim by the same
  agent prints a later `leaseEnd`. The same command with another `TIKK_AGENT` exits with 1 and
  `claimed`, and the message names the holder. Without `TIKK_AGENT`, it exits with 1 and
  `noTikkAgent`. A slice with no criteria exits with 1 and the field `criteria`, a draft slice the
  field `status`, and a task `wrongKind`.
- `target/debug/tikk show <slice> --json` has `claim` with `agent`, `session`, `sessionLog`,
  `leaseEnd`, and `state` (`claimed`, or `staleClaim` after the lease end), or `null`. Without
  `--json`, it prints a `claim: claimed by <agent> until <leaseEnd>` line. A claim line with a past
  `leaseEnd`, added to the fact file by hand, gives `staleClaim`, and another agent's claim then
  exits with 0.
- `TIKK_AGENT=manager target/debug/tikk done <instruction>` under the manager's claimed slice moves
  the slice's `leaseEnd` forward, and so do `new` and `cancel` of its instructions. The same
  commands without `TIKK_AGENT` leave it as it was. With another `TIKK_AGENT`, they exit with 1 and
  `claimed`, and change no file.
- `target/debug/tikk release <slice> --json` without `TIKK_AGENT` exits with 0, prints
  `{"id":...,"released":true}`, and appends a `release` line with `"agent":null`. With another
  agent's `TIKK_AGENT` on a live claim, it exits with 1 and `claimed`. On a slice with no claim, it
  prints `"released":false` and writes nothing.
- `target/debug/tikk ready --parent <plan> --json` exits with 0 and prints
  `{"candidates":[...],"errors":[],"skipped":[...]}`. Candidates are open slices, in rank order,
  then by ID, as `ls` rows. Each skipped row adds `holds`, such as
  `{"reason":"blockedBy","blocker":<id>,"via":null,"state":"open"}`. A blocker of the plan has the
  plan in `via`. A live claim gives `{"reason":"claimed","claim":{...}}`, and a draft slice
  `{"reason":"draft"}`. A blocker that does not exist has the state `missing`. A fact line that
  does not parse is in `errors` with its `path` and `line`. Without `--parent`, it lists the slices
  of the project that `tikk new` would choose, such as `tikk` from the worktree root, and
  `--project <p>` lists another project's. `--parent` with `--project` exits with 2. Without
  `--json`, it prints the candidate rows, then `skipped: <row>` with each hold indented below it.
- The store lock is the file `$TIKK_HOME/.git/tikk.lock`. While another process holds it, such as
  `flock $TIKK_HOME/.git/tikk.lock sleep 7`, `target/debug/tikk show <id> --json` waits five
  seconds, then exits with 1 and `locked`.

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
