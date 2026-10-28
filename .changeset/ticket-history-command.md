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
