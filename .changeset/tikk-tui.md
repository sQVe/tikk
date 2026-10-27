---
'tikk': minor
---

Open a terminal UI when you run `tikk` with no arguments in a terminal. The home view lists the same
items as `tikk needs`. Press `s` to switch to the plan tree, which shows plans, slices with their
state and PR number, and the instructions of active slices. Press `q` or Ctrl+C to quit, and use the
arrow keys or `j` and `k` to move.

The TUI reloads when tickets or facts change, also when another process writes them. Press `e` to
open the selected ticket in `$EDITOR`. The TUI resumes after the editor exits and shows the edit.
Queued editors run one at a time. Shutdown cancels queued editors without resuming the TUI. It stops
the active editor and attempts to stop its child processes. Cleanup failures are reported after the
terminal is restored, with a nonzero exit status.
