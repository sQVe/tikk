---
'tikk': minor
---

Open a terminal UI when you run `tikk` with no arguments in a terminal. The home view lists the same
items as `tikk needs`. Press `tab` to switch to the plan tree, which shows plans, slices with their
state and PR number, and the tasks of active slices. Press `q` or Ctrl+C to quit, and use the arrow
keys or `j` and `k` to move.

The TUI reloads when tickets or facts change, also when another process writes them. Press `e` to
open the selected ticket in `$EDITOR`. The TUI resumes after the editor exits and shows the edit.
