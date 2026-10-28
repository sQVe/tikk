---
'tikk': minor
---

Add `tikk history <id> [--json]`. It lists every fact of one ticket, newest first. Text output
prints one line per fact with its time, kind, and the first line of its text or reason.

The TUI tree view is now the Projects view. It lists every project with the current repository's
project first and unfolded. Each project shows an Inbox of loose tasks, then its plans, slices, and
tasks. A slice folds its instructions under an "Instructions (n)" row that counts their open needs.
Rows show kind and state as icons. `za` or `space` toggles a fold, `zo` opens it, and `zc` closes
it.

The detail panel reads any ticket. A header shows its title, kind, state, and where it sits. Below
it, an attention block lists what the ticket needs from you, at most four lines; `x` expands it.
Tabs Overview, Criteria, Activity, and Links follow, with counts. `[` and `]` switch tabs. Overview
shows the body, or the Outcome, Files, and First test sections of an instruction. Criteria is hidden
for instructions. Activity lists every fact of the ticket, newest first, with its time, kind, and
text; its count is the number of facts. `ctrl+d` and `ctrl+u` scroll the tab half a page, and `j`
and `k` scroll it one line in the full-screen detail.
