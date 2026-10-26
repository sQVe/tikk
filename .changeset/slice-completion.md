---
'tikk': minor
---

A merged, audited slice with an open instruction or an open task now has the state `flagged`, not
`done`, and it no longer clears the tickets it blocks. `tikk show` and `tikk needs` list the open
tasks in `openTasks` beside `openInstructions`. The `flagged` field of `tikk show` is gone; read the
state instead.

A plan is `done` once every slice that is not canceled is done and every direct task is done or
canceled. A done plan clears the tickets it blocks, and the tree shows the plan state.
