# tikk

## 0.1.0

### Minor Changes

- [#13](https://github.com/sQVe/tikk/pull/13)
  [`595c7eb`](https://github.com/sQVe/tikk/commit/595c7eb48fe492c0efdb73f9df0e72d8febd1743) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `tikk pr link`, `tikk reconcile`, and `tikk audit`.
  `tikk pr link` ties a slice to a GitHub PR. `tikk reconcile` reads PR facts with `gh`, and `ready`
  and `needs` run it first. A PR read that takes longer than 30 seconds stops and is reported as a
  problem. `tikk audit` records one verdict for each criterion of a slice for a repository, head,
  base, and change hash. `tikk show` and `tikk needs` now show a slice as `inReview`,
  `mergedUnverified`, or `done`, and flag a merged slice that has open tasks.

- [#9](https://github.com/sQVe/tikk/pull/9)
  [`81a6dad`](https://github.com/sQVe/tikk/commit/81a6dad16540f8a31fec1f3b273259c0b5db5577) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `tikk sync` and `tikk init --remote <url>`. Sync commits
  the store, fetches, merges, and pushes to its Git remote, and works offline. Facts from two
  machines merge with no conflict. When two machines edit one ticket, sync stops, leaves no merge in
  progress, and names the file. Sync leaves a ticket file out of the commit until it parses and has
  not changed for two seconds, and lists it as `pending`. After a write, a store with an `origin`
  remote syncs in the background after a three second delay. `tikk claim` fetches and merges first,
  so it sees claims made on other machines, and still works offline. When a merge brings in a ticket
  whose ID another ticket already uses, sync gives the newer ticket a new ID, renames its file, and
  records an `alias` fact. `tikk sync --json` lists these as `aliases`, and reports `remote`,
  `fetched`, `merged`, and `pushed` for each step. `tikk init --remote --json` also reports
  `pushed`.

- [#14](https://github.com/sQVe/tikk/pull/14)
  [`138e8af`](https://github.com/sQVe/tikk/commit/138e8af57c5903846c7c3cc5a104a2c73dc9e55a) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `tikk qa add` and `tikk qa ls` to record QA runs on a
  slice and list them as current or stale. An audit verdict can cite QA runs by run ID with `qa`,
  and `tikk audit` refuses a citation that does not fit.

- [#15](https://github.com/sQVe/tikk/pull/15)
  [`c596cdb`](https://github.com/sQVe/tikk/commit/c596cdb72f28cfbfbb4232fe98f21e4bfa30c880) Thanks
  [@sQVe](https://github.com/sQVe)! - Open a terminal UI when you run `tikk` with no arguments in a
  terminal. The home view lists the same items as `tikk needs`. Press `tab` to switch to the plan
  tree, which shows plans, slices with their state and PR number, and the tasks of active slices.
  Press `q` or Ctrl+C to quit, and use the arrow keys or `j` and `k` to move.

  The TUI reloads when tickets or facts change, also when another process writes them. Press `e` to
  open the selected ticket in `$EDITOR`. The TUI resumes after the editor exits and shows the edit.
  Queued editors run one at a time. Shutdown cancels queued editors without resuming the TUI. It
  stops the active editor and attempts to stop its child processes. Cleanup failures are reported
  after the terminal is restored, with a nonzero exit status.

- [#7](https://github.com/sQVe/tikk/pull/7)
  [`f21ff51`](https://github.com/sQVe/tikk/commit/f21ff512e957752a2a8a2351aa1bd8545d289c19) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `tikk needs`. It lists the tasks that wait on you:
  unanswered worker questions, submitted tasks that wait for acceptance, and claims whose lease has
  ended. Each item shows its reason and its age.

- [#6](https://github.com/sQVe/tikk/pull/6)
  [`b4fa5d7`](https://github.com/sQVe/tikk/commit/b4fa5d786b12718092b61016ba91ccbe15754c2a) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `tikk claim`, `release`, `log`, `submit`, `accept`,
  `cancel`, and `ready`. A holder claims a task with a lease, logs progress, and submits it for
  review, and `accept` marks it done. `ready` lists open tasks that nothing blocks and names what
  blocks the rest. `tikk show` reports a task's state and its active claim. Each write takes the
  store lock, so two agents cannot claim one task at once.

- [#11](https://github.com/sQVe/tikk/pull/11)
  [`f6b6be3`](https://github.com/sQVe/tikk/commit/f6b6be3809d155f75c5940f7bde94d13b6664cf1) Thanks
  [@sQVe](https://github.com/sQVe)! - `bun run install:local` installs the `tikk` command.

- [#14](https://github.com/sQVe/tikk/pull/14)
  [`138e8af`](https://github.com/sQVe/tikk/commit/138e8af57c5903846c7c3cc5a104a2c73dc9e55a) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `tikk coverage [<id>]`. It lists each plan criterion that
  no slice covers and each slice criterion that no task covers. It warns and exits 0 when it finds
  gaps.

- [#12](https://github.com/sQVe/tikk/pull/12)
  [`f0815aa`](https://github.com/sQVe/tikk/commit/f0815aa83d3b62fe4e3177a930d585e0f2adb910) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `tikk check`, `tikk review`, and `tikk finding`. They
  record check runs and reviews with their findings, list them for any ticket, and set the status of
  a finding. `tikk needs` now lists blocked findings.

- [#2](https://github.com/sQVe/tikk/pull/2)
  [`a7f2d70`](https://github.com/sQVe/tikk/commit/a7f2d70b33e46387cc6b47472e937e29169b12e3) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `tikk init`, `new`, `show`, `ls`, and `edit`. Each command
  has `--json` and never prompts. Tickets are Markdown files in the store, and a SQLite cache in
  `~/.cache/tikk` indexes them.

- [#1](https://github.com/sQVe/tikk/pull/1)
  [`5c5bccc`](https://github.com/sQVe/tikk/commit/5c5bccc1fa7bad0520f86ad1b69321717063a0a3) Thanks
  [@sQVe](https://github.com/sQVe)! - The `tikk` binary prints its version with `tikk --version`.

- [#8](https://github.com/sQVe/tikk/pull/8)
  [`5e99e54`](https://github.com/sQVe/tikk/commit/5e99e54df14ed4c48c57fb552b580b04a0404e50) Thanks
  [@sQVe](https://github.com/sQVe)! - Add plans, slices, and issues. `tikk new` creates every kind
  with criteria, ranks, and edges, and refuses a parent the tree does not allow or a link to a
  ticket that does not exist. `tikk close` closes an issue, and `tikk cancel` cancels a plan, slice,
  task, or issue. `tikk edit --kind slice|plan` turns an issue into a slice or plan in place, with
  `--parent` for a slice and `--criteria-file` for its criteria. An open plan or slice needs
  criteria. Every status change tikk writes appends a `status` fact.

  tikk now archives a plan or stand-alone ticket 14 days after it finishes. It sets
  `archived: <date>` on the ticket and on the plan's slices and tasks, and files never move. `ls`
  and `ready` leave archived tickets out, and `ls --archived` lists them. `tikk archive <id>` and
  `tikk unarchive <id>` set and clear the field on a ticket and its descendants. An unarchived
  ticket is not archived again for the same finish.

  `tikk ready --parent <plan>` returns the plan's slices whose blockers are cleared, in rank order,
  and names what blocks each slice it skipped. `ready --kind slice` does the same for every slice.
  `ready --parent <slice>` still returns that slice's tasks. A canceled or closed plan or slice no
  longer blocks a ticket that depends on it.

  `tikk claim` and `tikk submit` now check the task's parent and links like `tikk close` does, and
  refuse a task that points at a ticket that does not exist. `claim`, `submit`, and `close` accept
  `--force --reason <text>` to skip that check. The reason is recorded on the fact they append.
  `--force` needs `--reason`, and `--reason` needs `--force`.
