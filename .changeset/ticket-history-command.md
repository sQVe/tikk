---
'tikk': minor
---

Add `tikk history <id> [--json]`. It lists every fact of one ticket, newest first. Text output
prints one line per fact with its time, kind, and the first line of its text or reason.

The TUI tree view is now the Projects view. It lists every project with the current repository's
project first and unfolded. Each project shows an Inbox of loose tasks, then its plans, slices, and
tasks. A task or instruction whose parent is not shown in its project goes to that project's Inbox.
A slice folds its instructions under an "Instructions (n)" row that counts their open needs. Rows
show kind and state as icons. A slice that is not open, such as a draft, shows its stored status in
the tree, the detail panel, and `tikk show --json`. `za` or `space` toggles a fold, `zo` opens it,
and `zc` closes it. A ticket whose file does not parse keeps its row, but slice and plan states
ignore it, as `tikk show` does.

The detail panel reads any ticket. A header shows its title, kind, state, and where it sits. Below
it, an attention block lists what the ticket needs from you, at most four lines; `x` expands it.
Tabs Overview, Criteria, Activity, and Links follow, with counts. `[` and `]` switch tabs. Overview
shows the body, or the Outcome, Files, and First test sections of an instruction. Criteria is hidden
for instructions. Activity lists every fact of the ticket, newest first, with its time, kind, and
text; its count is the number of facts. `ctrl+d` and `ctrl+u` scroll the tab half a page, and `j`
and `k` scroll it one line in the full-screen detail. `tikk show --json` now also returns
`children`, the ID, kind, and title of each child ticket the Links tab shows. A plan's `state` now
comes from its slices, so `tikk show --json` returns `done` once they are done, and `status` keeps
the stored value.

In the TUI, `D` on a plan opens its `design.md` in `$EDITOR`. The CLI has the same action as
`tikk edit <id> --design`, with or without `--json`. It fails for a ticket that is not a plan, and
for a plan with no `design.md`. `--design` cannot be combined with field flags.

The config key `icons` picks the row icons: `unicode` (the default) or `nerdFont`. Any other value
is a config error, and the defaults stay in place.
