# QA guide

tikk ships `tikk`, a command line for agents and the user, and `tikk-desktop`, a desktop app. Today
`tikk` has `init`, `new`, `show`, `ls`, `write`, `edit`, `done`, `cancel`, `block`, `unblock`,
`move`, `rank`, `claim`, `release`, `ready`, `sync`, `pr link`, `pr refresh`, `audit`, `ask`,
`answer`, `needs`, `completions`, `--help`, and `--version`, and `tikk-desktop`
is a stub. A mock scene of the UI
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

| Journey                                                         | Goal                                                                            | Run it when the change touches                                                                                                | Test                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [tickets-by-hand](qa/journeys/tickets-by-hand.md)               | Set up a store and keep a plan's to-dos in order.                               | `tikk init`, `new`, `ls`, `cancel`, `rank`, `block`, CLI output                                                               | `crates/tikk-cli/tests/journey_tickets_by_hand.rs`        |
| [manager-runs-a-slice](qa/journeys/manager-runs-a-slice.md)     | Take a slice from ready to done, with no step that marks it done by hand.       | `tikk new --file`, `show`, `ready`, `claim`, `done`, `pr link`, `pr refresh`, `audit`, derived states, ticket validation      | `crates/tikk-cli/tests/journey_manager_runs_a_slice.rs`   |
| [trouble](qa/journeys/trouble.md)                               | Each failure is named with what to fix, and no ticket is lost.                  | Ticket parsing, error codes, `tikk ls`, `show`, `write`, `release`, `sync`, `claim`, `pr refresh`, ID clashes, the store lock | `crates/tikk-cli/tests/journey_trouble.rs`                |
| [two-machines](qa/journeys/two-machines.md)                     | See the same tickets on both machines, and never let two agents hold one slice. | `tikk init --remote`, `sync`, `claim`, `release`, Git calls of sync                                                           | `crates/tikk-cli/tests/journey_two_machines.rs`           |
| [what-waits-on-the-user](qa/journeys/what-waits-on-the-user.md) | See in one list everything that waits on the user, and clear it.                | `tikk ask`, `answer`, `needs`, `show`, `move`, `release`, `pr refresh`, `audit`, derived states, saved sync results           | `crates/tikk-cli/tests/journey_what_waits_on_the_user.rs` |

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
`--parent` and `--project`, `tikk ready` without them, and `tikk audit` without `--repository`
start `git config --get remote.origin.url` in the working directory. `tikk needs` starts the same
command in the store, with the policy of a local sync step. `tikk sync` and
`tikk init --remote` start `git` in the store with no hook, no signing, and no terminal prompt, as
the author `tikk <tikk@localhost>`. Their local steps read no global or system Git config. Their
network steps (`fetch`, `push`, `ls-remote`, and `clone`) keep it, so a credential helper or a
`url.<base>.insteadOf` there applies, and they stop after 30 seconds. `tikk init --remote` resolves a relative
path that names a folder from the working directory and saves it as an absolute `origin`; any
other relative name, such as an `insteadOf` alias, stays as given. Without
`--machine`, it also starts `uname -n`. `tikk pr link` and `tikk pr refresh` start `gh` with
`GH_PROMPT_DISABLED=1` and no standard input, and stop it after 30 seconds. They run
`gh pr view <number> --repo github.com/<owner/name> --json number,state,baseRefName,headRefOid,mergeCommit`,
and for a merged PR also `gh repo view github.com/<owner/name> --json defaultBranchRef`, then, when
the PR merged into a branch other than trunk and has a merge commit,
`gh api --hostname github.com repos/<owner/name>/compare/<trunk>...<merge commit>`. Each call names
`github.com`, so `GH_HOST` cannot send it to another server. No other command starts `gh`. All
run from `PATH` with an argument list. `tikk edit` splits `EDITOR` on whitespace into a program
and its arguments. It runs the program with no shell, with those arguments and then the ticket file
path. Without `EDITOR`, or with one that is empty or holds only whitespace, it exits with 1 and
`noEditor`.

### Identity

`TIKK_AGENT` names the agent that runs a command, `TIKK_SESSION` its session, and
`TIKK_SESSION_LOG` the path of the session's log. An empty value counts as unset. Without
`TIKK_AGENT`, the caller is a person. Unset all three before a check that runs as a person.

### Completion callback

The completion script that `tikk completions <shell>` prints starts `tikk` again on each Tab, with
`COMPLETE` set to the shell's name and the command line after `--`. With `COMPLETE` set, tikk
prints candidates instead of running a command. bash and zsh also pass `_CLAP_COMPLETE_INDEX`, the
index of the word to complete, and `_CLAP_IFS`, the separator of the candidates. fish passes
neither and completes the last word. No real shell is needed to probe it. Unset `COMPLETE` before
every other check.

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
  `{"claim":{"agent":"manager","leaseEnd":...,"session":"s-1","sessionLog":"/tmp/log.jsonl","state":"claimed"},"id":...,"sync":{...}}`.
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
  `{"id":...,"released":true,"sync":{...}}`, and appends a `release` line with `"agent":null`.
  With another agent's `TIKK_AGENT` on a live claim, it exits with 1 and `claimed`. On a slice with
  no claim, it prints `"released":false`, writes nothing, and makes no commit.
- `tikk claim` and `tikk release` sync the store. Their `sync` field has the shape of
  `tikk sync --json`'s result, and `$TIKK_HOME/.git/tikk-sync.json` holds it as the last result,
  also after a refused claim. With two stores on one local bare remote (see `tikk init --remote`
  below), `TIKK_AGENT=a tikk claim <slice> --json` on the first store commits the claim fact and
  pushes (`"pushed":true`). Then `TIKK_AGENT=b tikk claim <slice> --json` on the second store exits
  with 1 and `claimed`, with no `tikk sync` in either store. After
  `TIKK_AGENT=a tikk release <slice>` on the first store, the second store's claim exits with 0
  and prints `"merged":true`. A claim does not wait for files to settle: right after `tikk new`, the
  new ticket files are in `pending` with `"reason":"settling"`, only the fact is committed, and the
  other store's claim exits with 1 and `notFound`. After about two seconds, the next claim or
  release commits them. Without `--json`, the claim or release line is followed by the lines of
  `tikk sync`.
- With `origin` set to a missing path (`git -C "$TIKK_HOME" remote set-url origin /tmp/missing.git`),
  `TIKK_AGENT=b tikk claim <slice> --json` still exits with 0, prints `"fetched":false` and
  `"pushed":false`, and names the failed fetch as `{"step":"fetch",...}` under `sync.problems` and
  in `.git/tikk-sync.json`. A merge conflict in a claim is aborted, the claim exits with 0, and
  `sync.problems` has `{"step":"merge","files":["tickets/<project>/<file>"],...}`.
- `tikk new` on a store with a remote makes no commit: `git -C "$TIKK_HOME" rev-parse HEAD` is the
  same before and after.
- Two ticket files with one ID in one project, such as a copy `<id>-copy.md` of a slice file, are
  an ID clash. `tikk sync --json` lists it as
  `"clashes":[{"id":<id>,"paths":["tickets/<project>/<file>","tickets/<project>/<id>-copy.md"]}]`,
  and without `--json` as `idShared: <id>  <path>  <path>`. `tikk ls --json` lists it under
  `errors` as `{"code":"idShared","id":<id>,"paths":[...],"message":...}`, with absolute paths.
  `tikk show <id> --json`, `tikk claim`, `tikk release`, `tikk pr link`, `tikk pr refresh`, and
  `TIKK_AGENT=<holder> tikk done` on an instruction of the slice exit with 1 and print
  `{"error":{"code":"idShared","files":[<path>,<path>],...}}`, and write nothing. For a linked
  slice, `tikk pr refresh` with no slice refuses the same way before it runs `gh`.
  `tikk ready --json` lists each file of the slice as skipped with
  `{"reason":"idShared","paths":[...]}` and no `claimed` hold. After a rename of one file to a new
  ID, `tikk claim <id>` exits with 0.
- `target/debug/tikk ready --parent <plan> --json` exits with 0 and prints
  `{"candidates":[...],"errors":[],"skipped":[...]}`. Candidates are open slices, in rank order,
  then by ID, as `ls` rows. Each skipped row adds `holds`, such as
  `{"reason":"blockedBy","blocker":<id>,"via":null,"state":"open"}`. A blocker of the plan has the
  plan in `via`. A live claim gives `{"reason":"claimed","claim":{...}}`, and a draft slice
  `{"reason":"draft"}`. A slice under a draft or canceled plan gives
  `{"reason":"parent","parent":<plan>,"state":"draft"}` or `"state":"canceled"`. A slice whose ID
  is in two files gives `{"reason":"idShared","paths":[...]}`. A blocker that
  does not exist has the state `missing`. A fact line that
  does not parse is in `errors` with its `path` and `line`. Without `--parent`, it lists the slices
  of the project that `tikk new` would choose, such as `tikk` from the worktree root, and
  `--project <p>` lists another project's. `--parent` with `--project` exits with 2. Without
  `--json`, it prints the candidate rows, then `skipped: <row>` with each hold indented below it.
- `tikk pr link` and `tikk pr refresh` need a fake `gh`, never the real one. Make a folder with an
  executable `bin/gh` that is a copy of the `SCRIPT` text in
  `crates/tikk-cli/tests/support/gh.rs`, and run each command with `PATH=<folder>/bin:$PATH`. The
  script logs each call to `<folder>/calls.log` and answers from
  `<folder>/responses/pr/<owner>/<name>/<number>.json`, `responses/repo/<owner>/<name>.json`, and
  `responses/api/repos/<owner>/<name>/compare/main...<merge commit>.json`. A `.fail` file in place
  of a `.json` file makes the call print its text on standard error and exit with 1. An open PR is
  `{"number":7,"state":"OPEN","baseRefName":"main","headRefOid":"abc123","mergeCommit":null}`, and
  the repository is `{"defaultBranchRef":{"name":"main"}}`.
- `target/debug/tikk pr link <slice> https://github.com/owner/app/pull/7 --json` exits with 0,
  prints `{"id":<slice>,"pr":{"base":"main","head":"abc123","inTrunk":false,"mergeCommit":null,"number":7,"prCheckedAt":...,"repository":"owner/app","state":"open","url":"https://github.com/owner/app/pull/7"}}`,
  logs one `pr view 7 --repo github.com/owner/app --json number,state,baseRefName,headRefOid,mergeCommit`
  call, and appends a `{"v":1,"kind":"pr",...}` line with those fields to the fact file. Without
  `--json`, it prints `<slice>  <url> open at abc123, checked <time>`. A URL that is not
  `https://github.com/<owner>/<name>/pull/<number>` exits with 2 and `invalidArguments`, and a plan
  exits with 1 and `wrongKind`. With another agent's `TIKK_AGENT` on a live claim, it exits with 1
  and `claimed`, logs no `gh` call, and writes nothing. With the holder's `TIKK_AGENT`, it moves
  the slice's `leaseEnd` forward. With `PATH` set to an empty folder, it exits with 1 and
  `ghError`, and the error has `pullRequests` with the slice's `id`, `repository`, `number`,
  `url`, and `message`.
- After a link, `target/debug/tikk show <slice> --json` has `pr` with the same fields, and
  `prCheckedAt` is the time of the newest `pr` line of that PR. Without `--json`, it prints a
  `pr: <url> open at abc123, checked <time>` line. A ticket with no PR has `"pr":null`.
- After a link, `target/debug/tikk ready --parent <plan> --json` lists a slice whose own
  `blockedBy` names the linked slice as a candidate with
  `"stackParent":{"head":"abc123","number":7,"prCheckedAt":...,"repository":"owner/app","slice":<linked slice>,"url":...}`.
  Other candidates have `"stackParent":null`. Without `--json`, the candidate row is followed by
  `  stacks on <url> of <linked slice> at abc123, checked <time>`. `tikk ready` and `tikk show`
  add no line to `calls.log`.
- `target/debug/tikk pr refresh --json` reads every linked PR not yet in trunk and prints
  `{"auditBehind":[],"refreshed":[{"id":<slice>,"pr":{...}}]}`. A PR answered as
  `"state":"MERGED"` with `"baseRefName":"feature"` and `"mergeCommit":{"oid":"def456"}` logs a
  `repo view` and an `api --hostname github.com repos/owner/app/compare/main...def456` call, and
  has `"inTrunk":false` while the compare answer is `{"status":"ahead"}` and `"inTrunk":true` after
  it is `{"status":"behind"}`. The next `tikk pr refresh --json` prints
  `{"auditBehind":[],"refreshed":[]}` and logs no call. `tikk pr refresh <slice>` reads that
  slice's PR even when it is in trunk, and a slice with no PR exits with 1 and `notLinked`. Without
  `--json`, it prints a line per PR, or `No PR to refresh.`
- When the fake `gh` fails for one of two linked PRs, `target/debug/tikk pr refresh --json` exits
  with 1, records the other PR, and prints
  `{"error":{"code":"ghError","message":"gh could not read <url> of <slice> (...)","pullRequests":[...]}}`
  that names only the failed PR. `tikk ready` then still exits with 0.
- `target/debug/tikk audit <slice> --hash <hash> --head <sha> --file <path> --repository owner/app
  --json`, with the `hash` of `tikk show <slice> --json` and a file that holds
  `[{"criterion":"s1","verdict":"met","evidence":"seen"}]`, exits with 0 and prints
  `{"audit":{"at":...,"head":<sha>,"repository":"owner/app","ticketHash":<hash>,"verdicts":[{"check":...,"criterion":"s1","evidence":"seen","expected":...,"verdict":"met"}]},"id":<slice>}`.
  It appends a `{"v":1,"kind":"audit",...}` line with those fields to the fact file and runs no
  `gh`. Without `--json`, it prints `<slice>  audit of owner/app at <sha>: 1 of 1 met, at <time>`.
  Without `--repository`, it reads the GitHub repository from `origin` of the working directory,
  such as a folder with `git init` and `git remote add origin https://github.com/owner/app.git`.
  Outside a repository, or with an `origin` that is not on `github.com`, it exits with 1 and
  `noRepository`. An old hash exits with 1 and `changedOnDisk`, a criterion the slice does not have
  exits with 1 and `unknownCriterion` and names it, and a verdict such as `passed`, an empty
  evidence, a criterion named twice, or a file that is not a JSON list exits with 2 and
  `invalidArguments`. A slice with no criteria exits with 1, `invalidTicket`, and the field
  `criteria`, and a plan exits with 1 and `wrongKind`. With another agent's `TIKK_AGENT` on a live
  claim, it exits with 1 and `claimed`; with the holder's, it moves `leaseEnd` forward. Each refused
  audit appends no line.
- `target/debug/tikk show <id> --json` of a plan or a slice keeps the stored `status` and adds
  `derivedStatus`: `open`, `auditBehind`, `mergedUnverified`, `done`, or the stored `draft` or
  `canceled`. A slice also has `audit`: `null`, or the last audit with `counts` and `reasons`, such
  as `[{"reason":"notMet","criterion":"s1"}]`. The reasons are `headDiffers`,
  `repositoryDiffers` (owner and name compare without letter case), `criterionChanged`,
  `criterionMissing`, `notMet`, `noCriteria` for a slice with no criterion left, and `notLinked`
  for a slice with no PR. To give a slice a PR state without `gh`, append a line such as
  `{"v":1,"kind":"pr","ticket":<slice>,"at":"2026-11-13T01:00:00Z","repository":"owner/app","number":7,"state":"merged","base":"main","head":<sha>,"mergeCommit":"def","inTrunk":true}`
  to the fact file. With that line and no audit, the slice is `mergedUnverified`; after an audit
  with `met` for each criterion at that head and repository, it is `done`, and the plan is `done`
  once each slice and task under it that is not canceled is done. An open PR (`"state":"open"`,
  `"inTrunk":false`) with another head than the audit gives `auditBehind` and `headDiffers`.
  Without `--json`, the row prints `open (done)`, and a line
  `audit of owner/app at <sha>: 1 of 1 met, at <time>, counts` follows the `pr:` line.
- `target/debug/tikk ls --json` rows and the `children` of `tikk show` add `derivedStatus` for
  plans and slices, and keep `status`. `tikk ls --status open` still lists a done slice. Without
  `--json`, the status column prints `open (done)`. `tikk done <slice>` still exits with 1 and
  `wrongKind`.
- In `target/debug/tikk ready --parent <plan> --json`, a done slice is neither a candidate nor
  skipped, and a slice it blocks is a candidate with `"stackParent":null`. A `mergedUnverified`
  slice is skipped with `{"reason":"mergedUnverified"}`, and a slice it blocks has
  `{"reason":"blockedBy",...,"state":"mergedUnverified"}`.
- Append a line that does not parse, such as `{"v":1,"kind":"audit"`, to a fact file. While it is
  there, a slice that was `done` reads `mergedUnverified` in `show`, `ls`, and `ready`, its plan
  reads `open`, a plan whose only members are done tasks reads `open`, and `ready --json` lists
  the line in `errors`. An audit line with two verdicts for one criterion is such a line. Replace a ticket file of the store
  with `---\nkind: [\n---\n`. While it is there, no plan reads `done`; an open plan reads `open`,
  slices keep their derived state, and `ls --json` lists the file in `errors`.
- With the fake `gh` answering an open PR with a new `headRefOid`,
  `target/debug/tikk pr refresh --json` prints `"auditBehind":[<slice>]` beside `refreshed` for a
  slice whose last audit saw another head, and `"auditBehind":[]` after an audit of the new head.
  Without `--json`, it adds the line `<slice>  auditBehind: the PR head differs from the last audit`.
- `target/debug/tikk ask <id> --text "Which crate?" --json` exits with 0 on any ticket kind and
  prints `{"answer":null,"askedAt":...,"id":<id>,"item":<4 characters>,"text":"Which crate?"}`. It
  appends a `{"v":1,"kind":"question",...}` line with `item` and `text` to the fact file. Blank
  `--text` exits with 2 and `invalidArguments`, and a missing ticket exits with 1 and `notFound`.
  With another agent's `TIKK_AGENT` on a live claim of the slice, or of an instruction's slice, it
  exits with 1 and `claimed` and appends nothing. By the holder, it appends the question, then a
  `claim` line with a later `leaseEnd`. Without `TIKK_AGENT`, no claim refuses it.
- `target/debug/tikk answer <id> <item> --text serde-saphyr --json` exits with 0, prints the
  question with `"answer":{"answeredAt":...,"text":"serde-saphyr"}`, and appends a
  `{"v":1,"kind":"answer",...}` line. A second answer replaces the first in `show`. An item the
  ticket does not have exits with 1 and `unknownQuestion`, and the message names the item. An item
  that is not 4 characters of the ID alphabet exits with 2. Without `--json`, `ask` and `answer`
  print `<id>  question <item>: <text> (open)`, or the question and `answer: <answer>`.
- `target/debug/tikk show <id> --json` has `questions`: `[]`, or one
  `{"answer":...,"askedAt":...,"item":...,"text":...}` per question in the order asked, with
  `answer` `null` until an answer. Without `--json`, each question is one line:
  `question <item>: <text> (open)`, or `question <item>: <text> answer: <answer>`.
- `target/debug/tikk needs --json` exits with 0, runs no `gh` and no network Git, and prints
  `{"items":[...],"problems":[...]}`. Items come in this order of reasons, then by ID:
  - `question` with `id`, `item`, and `text` for each open question.
  - `staleClaim` with `id`, `holder`, and `leaseEnd` for a claim whose lease ended. Append a claim
    line with a 2020 `at` and `leaseEnd` to make one.
  - `blockingTask` with `id` and `blocks` for an open task in an unfinished ticket's `blockedBy`.
  - `looseTask` with `id` for an open task with no parent.
  - `mergedUnverified` with `id`, `pr`, and `prCheckedAt` for a slice whose PR the fake `gh`
    reported merged into trunk, after `tikk pr refresh`, with no audit.

  Problems carry a `code`: `parseError` with `path` for a broken ticket file, `idShared` with `id`
  and `paths` for a copied ticket file, `factUnreadable` with `path` and `line` for a fact line
  such as `{"v":1,`, and `syncFailed` with `at`, `message`, and `files` after a `tikk sync` that
  stopped on a conflict, and `syncProblem` with `step` for a sync step that failed. In a store with
  no `origin` remote, a sync, claim, or release leaves no `syncProblem` of the `fetch` step in
  `needs`, so such a store can list no items and no problems. With an `origin` that cannot be
  fetched, the `fetch` problem shows. Without `--json`, it prints one line per item, such as
  `<task>  blockingTask: blocks <slice>`, then one `problem <code>: <path>: <message>` line per
  problem, or `Nothing waits on you.` when both lists are empty.
- `target/debug/tikk completions bash`, `zsh`, and `fish` exit with 0 and print a script on
  standard output that `bash -n`, `zsh -n`, and `fish -n` accept. Each script is the same text that
  `COMPLETE=<shell> target/debug/tikk` prints. With `--json`, it prints `{"script":...}`. Without a
  shell, it exits with 2. `tikk completions --help` says how to load the script in bash, zsh, and
  fish. Started from a copy at a path with a space, such as `/tmp/a b/tikk`, the bash script calls
  `'/tmp/a b/tikk'` without double quotes around it. Started through a path that is not valid
  Unicode, it prints no script and exits with 1 and `programPathNotUnicode`.
- ID completion: in a store with a plan, slices A and B under it, an instruction under A, and a
  loose task, `COMPLETE=fish target/debug/tikk -- tikk block <task> ""` prints every ID with a tab
  and its title, then the flags. `COMPLETE=fish target/debug/tikk -- tikk move <instruction>
  --parent ""` prints only the two slices, and `COMPLETE=fish target/debug/tikk -- tikk rank <A>
  --before ""` prints only B. `COMPLETE=fish target/debug/tikk -- tikk new instruction T --parent
  ""` prints only the two slices, and `tikk ls --parent ""` and `tikk ready --parent ""` print
  the plan and the two slices. `COMPLETE=bash _CLAP_COMPLETE_INDEX=3 target/debug/tikk -- tikk block
  <task> ""` prints the IDs without titles, then the flags. After `rm "$TIKK_HOME/.git/tikk.lock"`,
  a completion creates no lock file and changes no file. A `TIKK_HOME` with no store prints only
  the flags, nothing on standard error, and exits with 0. `COMPLETE=tcsh` exits with 2 and names
  the shells it knows.
- `target/debug/tikk init --remote <remote> --machine laptop --json`, with an empty local bare
  remote made by `git init --bare --initial-branch=main /tmp/tikk-qa-remote.git`, exits with 0,
  prints `{"created":true,"store":"<TIKK_HOME>"}`, and pushes the first commit
  (`git -C /tmp/tikk-qa-remote.git log --oneline main`). The same command with another
  `TIKK_HOME` and `--machine desktop` clones the store. Without `--machine`, on a remote whose
  `main` holds `facts/<first label of uname -n>/`, it exits with 1 and `machineInUse`, the message
  names the folder and `--machine`, and `TIKK_HOME` stays absent. On a `TIKK_HOME` that holds a
  store, it prints `"created":false` and adds no remote.
- `target/debug/tikk sync --json` exits with 0 and prints
  `{"clashes":[...],"committed":...,"committedPaths":[...],"fetched":...,"merged":...,"pending":[...],"problems":[...],"pushed":...}`.
  Right after `tikk new`, it waits about two seconds, then commits the new ticket file and pushes.
  Then `tikk sync` with the other store's `TIKK_HOME` prints `"merged":true`, and `tikk ls` there
  lists the ticket. A ticket file that holds only `kind: [` is in `pending` with
  `"reason":"unparsed"` and stays out of the commit. Without `--json`, it prints
  `committed: <count>  fetched: yes  merged: no  pushed: yes`, then a line per pending file and
  per problem and per clash.
- `target/debug/tikk sync --json` on a store made with `tikk init`, with no `origin`, exits with 0,
  commits, and prints `"fetched":false` with `{"step":"fetch",...}` under `problems`.
- When both stores change one ticket file and each runs `target/debug/tikk sync --json`, the second
  exits with 1, prints nothing on standard output, and prints
  `{"error":{"code":"conflict","files":["tickets/<project>/<file>"],...}}` on standard error. Its
  `git -C "$TIKK_HOME" status` shows no merge in progress, and the file keeps its local text.
- After each `tikk sync`, `$TIKK_HOME/.git/tikk-sync.json` holds the last result with its `at`
  time, or `error` and `conflict` after a conflict.
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
