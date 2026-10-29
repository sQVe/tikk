# tikk

## 0.1.0

### Minor Changes

- [#27](https://github.com/sQVe/tikk/pull/27)
  [`d7e78a0`](https://github.com/sQVe/tikk/commit/d7e78a0669a64191a55350fafa11f0a1459970fc) Thanks
  [@sQVe](https://github.com/sQVe)! - The terminal UI shows the list and the selected row's detail
  side by side when the terminal is at least 90 columns wide. In a narrower terminal, press Enter to
  open the detail full screen, and press Esc to return to the list.

  Press `?` to open help. Help lists the key for each action. An action that cannot run now shows
  the reason, such as "No ticket is selected." Press `gm` to see recent messages, such as a failed
  editor run or a problem in a ticket file.

  Change keys in `~/.config/tikk/config.json`. The same file holds the `projects` and `machine`
  settings. Each key names a command by its ID. For example, `{ "keys": { "help": ["h"] } }` moves
  help from `?` to `h`. Ctrl+C always quits. When the file has an error, the terminal UI keeps the
  default keys, and its messages name the file and the problem.

- [#25](https://github.com/sQVe/tikk/pull/25)
  [`6951e5b`](https://github.com/sQVe/tikk/commit/6951e5ba16056360b2754067545b7a20821c6df7) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `--covers <criterion>` and `--clear-covers` to
  `tikk edit`. `--covers` replaces the list of criteria that a slice or an instruction covers. Every
  name must be a criterion of the parent, and a slice with no parent cannot set it. `--clear-covers`
  removes the list, so an instruction with no `covers` covers all of its slice's criteria again.

- [#21](https://github.com/sQVe/tikk/pull/21)
  [`a5ecfa0`](https://github.com/sQVe/tikk/commit/a5ecfa061ddfbb1727ed0a46d9f9fbc7feebbd46) Thanks
  [@sQVe](https://github.com/sQVe)! - Files in a ticket's design folder sync to other machines as
  they are, and the cache never reads them as tickets. When a sync clash gives a ticket a new ID,
  its design folder moves to the new ID too. `tikk show --json` lists the files in a ticket's design
  folder.

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

- [#8](https://github.com/sQVe/tikk/pull/8)
  [`5e99e54`](https://github.com/sQVe/tikk/commit/5e99e54df14ed4c48c57fb552b580b04a0404e50) Thanks
  [@sQVe](https://github.com/sQVe)! - Add plans, slices, and tasks. `tikk new` creates every kind
  with criteria, ranks, and edges, and refuses a parent the tree does not allow or a link to a
  ticket that does not exist. `tikk done` marks a task done, and `tikk cancel` cancels a plan,
  slice, instruction, or task. `tikk edit --kind slice|plan` turns a loose open task into a slice or
  plan in place, with `--parent` for a slice and `--criteria-file` for its criteria. An open plan or
  slice needs criteria. Every status change tikk writes appends a `status` fact.

  tikk now archives a plan or stand-alone ticket 14 days after it finishes. It sets
  `archived: <date>` on the ticket and on the plan's slices and instructions, and files never move.
  `ls` and `ready` leave archived tickets out, and `ls --archived` lists them. `tikk archive <id>`
  and `tikk unarchive <id>` set and clear the field on a ticket and its descendants. An unarchived
  ticket is not archived again for the same finish.

  `tikk ready --parent <plan>` returns the plan's slices whose blockers are cleared, in rank order,
  and names what blocks each slice it skipped. `ready --kind slice` does the same for every slice.
  `ready --parent <slice>` still returns that slice's instructions. A canceled or done plan or slice
  no longer blocks a ticket that depends on it.

  `tikk claim` and `tikk submit` now check the instruction's parent and links like `tikk done` does,
  and refuse an instruction that points at a ticket that does not exist. `claim`, `submit`, and
  `done` accept `--force --reason <text>` to skip that check. The reason is recorded on the fact
  they append. `--force` needs `--reason`, and `--reason` needs `--force`.

- [#11](https://github.com/sQVe/tikk/pull/11)
  [`f6b6be3`](https://github.com/sQVe/tikk/commit/f6b6be3809d155f75c5940f7bde94d13b6664cf1) Thanks
  [@sQVe](https://github.com/sQVe)! - `bun run install:local` installs the `tikk` command.

- [#12](https://github.com/sQVe/tikk/pull/12)
  [`f0815aa`](https://github.com/sQVe/tikk/commit/f0815aa83d3b62fe4e3177a930d585e0f2adb910) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `tikk check`, `tikk review`, and `tikk finding`. They
  record check runs and reviews with their findings, list them for any ticket, and set the status of
  a finding. `tikk needs` now lists blocked findings.

- [#25](https://github.com/sQVe/tikk/pull/25)
  [`6951e5b`](https://github.com/sQVe/tikk/commit/6951e5ba16056360b2754067545b7a20821c6df7) Thanks
  [@sQVe](https://github.com/sQVe)! - Add
  `tikk rank <id> --first | --last | --before <sibling> | --after <sibling>` to place a ticket among
  its siblings, which sets the order that `tikk ready` and the tree list. Siblings share a project,
  a parent, and a kind. Ranking a loose task clears its `new` state.

- [#15](https://github.com/sQVe/tikk/pull/15)
  [`c596cdb`](https://github.com/sQVe/tikk/commit/c596cdb72f28cfbfbb4232fe98f21e4bfa30c880) Thanks
  [@sQVe](https://github.com/sQVe)! - Open a terminal UI when you run `tikk` with no arguments in a
  terminal. The home view lists the same items as `tikk needs`. Press `s` to switch to the plan
  tree, which shows plans, slices with their state and PR number, and the instructions of active
  slices. Press `q` or Ctrl+C to quit, and use the arrow keys or `j` and `k` to move.

  The TUI reloads when tickets or facts change, also when another process writes them. Press `e` to
  open the selected ticket in `$EDITOR`. The TUI resumes after the editor exits and shows the edit.
  Queued editors run one at a time. Shutdown cancels queued editors without resuming the TUI. It
  stops the active editor and attempts to stop its child processes. Cleanup failures are reported
  after the terminal is restored, with a nonzero exit status.

- [#18](https://github.com/sQVe/tikk/pull/18)
  [`5be57f2`](https://github.com/sQVe/tikk/commit/5be57f23f53deb27de022b50d7372f97b0740e2a) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `tikk claim`, `release`, `log`, `submit`, `accept`,
  `cancel`, and `ready`. A holder claims a instruction with a lease, logs progress, and submits it
  for review, and `accept` marks it done. `ready` lists open instructions that nothing blocks and
  names what blocks the rest. `tikk show` reports an instruction's state and its active claim. Each
  write takes the store lock, so two agents cannot claim one instruction at once.

- [#25](https://github.com/sQVe/tikk/pull/25)
  [`6951e5b`](https://github.com/sQVe/tikk/commit/6951e5ba16056360b2754067545b7a20821c6df7) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `tikk block <id> <blocker>` and
  `tikk unblock <id> <blocker>`. They add or remove one `blockedBy` edge on an existing ticket.
  Block refuses a missing blocker, the ticket itself, and a blocker that would form a cycle through
  `blockedBy` or parent links, and the error names the cycle.

- [#7](https://github.com/sQVe/tikk/pull/7)
  [`f21ff51`](https://github.com/sQVe/tikk/commit/f21ff512e957752a2a8a2351aa1bd8545d289c19) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `tikk needs`. It lists the instructions that wait on you:
  unanswered worker questions, submitted instructions that wait for acceptance, and claims whose
  lease has ended. Each item shows its reason and its age.

- [#25](https://github.com/sQVe/tikk/pull/25)
  [`6951e5b`](https://github.com/sQVe/tikk/commit/6951e5ba16056360b2754067545b7a20821c6df7) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `tikk move <id> --parent <id>` and
  `tikk move <id> --no-parent` to change the parent of an existing ticket.

- [#1](https://github.com/sQVe/tikk/pull/1)
  [`5c5bccc`](https://github.com/sQVe/tikk/commit/5c5bccc1fa7bad0520f86ad1b69321717063a0a3) Thanks
  [@sQVe](https://github.com/sQVe)! - The `tikk` binary prints its version with `tikk --version`.

- [#2](https://github.com/sQVe/tikk/pull/2)
  [`a7f2d70`](https://github.com/sQVe/tikk/commit/a7f2d70b33e46387cc6b47472e937e29169b12e3) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `tikk init`, `new`, `show`, `ls`, and `edit`. Each command
  has `--json` and never prompts. Tickets are Markdown files in the store, and a SQLite cache in
  `~/.cache/tikk` indexes them.

- [#18](https://github.com/sQVe/tikk/pull/18)
  [`5be57f2`](https://github.com/sQVe/tikk/commit/5be57f23f53deb27de022b50d7372f97b0740e2a) Thanks
  [@sQVe](https://github.com/sQVe)! - Rename the worker ticket kind from `task` to `instruction`.
  `tikk new instruction`, `tikk ready --kind instruction`, and the other commands use the new name.
  An instruction must name a slice as its parent, so `tikk new instruction` refuses a missing parent
  and a plan parent.

- [#14](https://github.com/sQVe/tikk/pull/14)
  [`138e8af`](https://github.com/sQVe/tikk/commit/138e8af57c5903846c7c3cc5a104a2c73dc9e55a) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `tikk coverage [<id>]`. It lists each plan criterion that
  no slice covers and each slice criterion that no instruction covers. It warns and exits 0 when it
  finds gaps.

- [#26](https://github.com/sQVe/tikk/pull/26)
  [`c5d389b`](https://github.com/sQVe/tikk/commit/c5d389b396c4c80a4b66e1cb0248742ee13bbd2b) Thanks
  [@sQVe](https://github.com/sQVe)! - List in `tikk needs` only what the manager passed up to you.
  Questions and submissions get a stable item ID, which `tikk log --type question` and `tikk submit`
  print. Add `tikk pass-up <id> --item <item>` to pass a question or the current submission up. A
  question that nobody passed up shows in Needs after 30 minutes. A submission shows only after a
  pass-up. `tikk log --type answer` now needs `--item` and refuses an item that is not an open
  question. `tikk accept` records the submission it accepts. Add `tikk reject <id> --reason <text>`,
  which reopens a submitted instruction and ends its claim. A synced rejection or accept of an
  earlier submission changes nothing. `tikk show` shows the latest rejection until the next
  submission. A question item in `tikk needs` carries the question text and shows it as its subject.
  Fact lines of questions, answers, submissions, and accepts now need an `item`.

- [#19](https://github.com/sQVe/tikk/pull/19)
  [`18fbd5b`](https://github.com/sQVe/tikk/commit/18fbd5bb35a5d7e76c1ecfa0c7a19e1fb38398b6) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `task` tickets for a person's to-do. A task can sit under
  a plan, under a slice, or with no parent. Its status is `open`, `done`, or `canceled`, and it has
  no claim, log, or submit.

  `tikk new task --json` with no parent marks the task `new: true`. Plain `tikk new task`, and a
  task with a parent, do not. Marking a task done or canceled removes the flag.

  `tikk review add` accepts a slice or an instruction only, and refuses other kinds.

- [#34](https://github.com/sQVe/tikk/pull/34)
  [`b328d0a`](https://github.com/sQVe/tikk/commit/b328d0af0b7be6263fccc3adef2cfb205943a1af) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `tikk history <id> [--json]`. It lists every fact of one
  ticket, newest first. Text output prints one line per fact with its time, kind, and the first line
  of its text or reason.

  The TUI tree view is now the Projects view. It lists every project with the current repository's
  project first and unfolded. Each project shows an Inbox of loose tasks, then its plans, slices,
  and tasks. A task or instruction whose parent is not shown in its project goes to that project's
  Inbox. A slice folds its instructions under an "Instructions (n)" row that counts their open
  needs. Rows show kind and state as icons. A slice that is not open, such as a draft, shows its
  stored status in the tree, the detail panel, and `tikk show --json`. `za` or `space` toggles a
  fold, `zo` opens it, and `zc` closes it. A ticket whose file does not parse keeps its row, but
  slice and plan states ignore it, as `tikk show` does.

  The detail panel reads any ticket. A header shows its title, kind, state, and where it sits. Below
  it, an attention block lists what the ticket needs from you, at most four lines; `x` expands it.
  Tabs Overview, Criteria, Activity, and Links follow, with counts. `[` and `]` switch tabs.
  Overview shows the body, or the Outcome, Files, and First test sections of an instruction.
  Criteria is hidden for instructions. Activity lists every fact of the ticket, newest first, with
  its time, kind, and text; its count is the number of facts. `ctrl+d` and `ctrl+u` scroll the tab
  half a page, and `j` and `k` scroll it one line in the full-screen detail. `tikk show --json` now
  also returns `children`, the ID, kind, and title of each child ticket the Links tab shows. A
  plan's `state` now comes from its slices, so `tikk show --json` returns `done` once they are done,
  and `status` keeps the stored value.

  In the TUI, `D` on a plan opens its `design.md` in `$EDITOR`. The CLI has the same action as
  `tikk edit <id> --design`, with or without `--json`. It fails for a ticket that is not a plan, and
  for a plan with no `design.md`. `--design` cannot be combined with field flags.

  The config key `icons` picks the row icons: `unicode` (the default) or `nerdFont`. Any other value
  is a config error, and the defaults stay in place.

- [#24](https://github.com/sQVe/tikk/pull/24)
  [`b33b1f7`](https://github.com/sQVe/tikk/commit/b33b1f701c543b605074a2175d22dee2478cb5e5) Thanks
  [@sQVe](https://github.com/sQVe)! - A merged, audited slice with an open instruction or an open
  task now has the state `flagged`, not `done`, and it no longer clears the tickets it blocks.
  `tikk show` and `tikk needs` list the open tasks in `openTasks` beside `openInstructions`. The
  `flagged` field of `tikk show` is gone; read the state instead.

  A plan is `done` once every slice that is not canceled is done and every direct task is done or
  canceled. A done plan clears the tickets it blocks, and the tree shows the plan state.

  `tikk ready` now holds back an instruction when its slice or the slice's plan has an open blocker,
  and holds back a slice when its plan has one. Each blocker that comes from a slice or plan carries
  `via`, the ticket that names it, in `--json` and in the text output. A slice blocked by a slice
  whose PR is open is not held back. Such a ready slice lists that PR as `stackParents` in `--json`,
  and the text output names it as `stack on <id> #<number>`. A task blocker never clears this way.

- [#14](https://github.com/sQVe/tikk/pull/14)
  [`138e8af`](https://github.com/sQVe/tikk/commit/138e8af57c5903846c7c3cc5a104a2c73dc9e55a) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `tikk qa add` and `tikk qa ls` to record QA runs on a
  slice and list them as current or stale. An audit verdict can cite QA runs by run ID with `qa`,
  and `tikk audit` refuses a citation that does not fit.

- [#13](https://github.com/sQVe/tikk/pull/13)
  [`595c7eb`](https://github.com/sQVe/tikk/commit/595c7eb48fe492c0efdb73f9df0e72d8febd1743) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `tikk pr link`, `tikk reconcile`, and `tikk audit`.
  `tikk pr link` ties a slice to a GitHub PR. `tikk reconcile` reads PR facts with `gh`, and `ready`
  and `needs` run it first. A PR read that takes longer than 30 seconds stops and is reported as a
  problem. `tikk audit` records one verdict for each criterion of a slice for a repository, head,
  base, and change hash. `tikk show` and `tikk needs` now show a slice as `inReview`,
  `mergedUnverified`, or `done`, and flag a merged slice that has open instructions.

- [#26](https://github.com/sQVe/tikk/pull/26)
  [`c5d389b`](https://github.com/sQVe/tikk/commit/c5d389b396c4c80a4b66e1cb0248742ee13bbd2b) Thanks
  [@sQVe](https://github.com/sQVe)! - `tikk needs` also lists an open task that blocks an unfinished
  ticket, a loose task that `tikk new` created, and a draft plan while it waits for you. Add
  `tikk wait <id> [--text <text>]`, which marks a draft plan as waiting for you, and
  `tikk wait <id> --done`, which clears the mark. `tikk wait` refuses any ticket that is not a draft
  plan.

### Patch Changes

- [#33](https://github.com/sQVe/tikk/pull/33)
  [`7d69a18`](https://github.com/sQVe/tikk/commit/7d69a1849f2a8d507ad8deb6079350f3ea15e798) Thanks
  [@sQVe](https://github.com/sQVe)! - After a sync gives a ticket a new ID because of an ID clash,
  its claim, log entries, and other facts from before the clash now show under the new ID. Before,
  they stayed under the old ID, which the other ticket kept.

  While two ticket files share an ID, commands that write a fact for that ID fail with an `idShared`
  error until `tikk sync` resolves the clash.

- [#29](https://github.com/sQVe/tikk/pull/29)
  [`e576af0`](https://github.com/sQVe/tikk/commit/e576af0eb30e9d105c4bd0665434268d4d3ead43) Thanks
  [@sQVe](https://github.com/sQVe)! - The terminal UI now draws in your terminal theme's colors
  instead of fixed ones. Text uses the default foreground, labels and hints use the dim attribute,
  keys and headings use the theme's yellow and blue, and the help and message overlays use the
  default background. The selected row is now bold.

- [#30](https://github.com/sQVe/tikk/pull/30)
  [`1b29f08`](https://github.com/sQVe/tikk/commit/1b29f08f0981de11dfb0f36d000bc04f2c06a2f1) Thanks
  [@sQVe](https://github.com/sQVe)! - An audit no longer counts after a criterion's check or
  expected text changes, so the slice shows as merged but unverified until a new audit runs.

  `tikk audit` takes `--hash` with the ticket hash from `tikk show`, and it refuses a ticket changed
  since that hash.

- [#32](https://github.com/sQVe/tikk/pull/32)
  [`f0af380`](https://github.com/sQVe/tikk/commit/f0af3805edf2493e8564fa41e905a3287cf10a1d) Thanks
  [@sQVe](https://github.com/sQVe)! - A command that reads the cache reports a `storeError` when
  another process keeps the cache busy during its query. With `--json`, it prints the error as JSON
  instead of exiting with no output.

- [#32](https://github.com/sQVe/tikk/pull/32)
  [`f0af380`](https://github.com/sQVe/tikk/commit/f0af3805edf2493e8564fa41e905a3287cf10a1d) Thanks
  [@sQVe](https://github.com/sQVe)! - When two processes find the same stale store lock left by a
  process that died while clearing it, only one of them clears it and takes the store lock. Before,
  both could hold the lock at once.

- [#27](https://github.com/sQVe/tikk/pull/27)
  [`d7e78a0`](https://github.com/sQVe/tikk/commit/d7e78a0669a64191a55350fafa11f0a1459970fc) Thanks
  [@sQVe](https://github.com/sQVe)! - When the terminal UI stops an editor and cannot list its
  processes, tikk now waits for the editor to exit before it reports the cleanup failure. A stubborn
  editor still ends the wait after one second, and the failure and exit code are unchanged.
