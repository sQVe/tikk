---
'tikk': minor
---

A merged, audited slice with an open instruction or an open task now has the state `flagged`, not
`done`, and it no longer clears the tickets it blocks. `tikk show` and `tikk needs` list the open
tasks in `openTasks` beside `openInstructions`. The `flagged` field of `tikk show` is gone; read the
state instead.

A plan is `done` once every slice that is not canceled is done and every direct task is done or
canceled. A done plan clears the tickets it blocks, and the tree shows the plan state.

`tikk ready` now holds back an instruction when its slice or the slice's plan has an open blocker,
and holds back a slice when its plan has one. Each blocker that comes from a slice or plan carries
`via`, the ticket that names it, in `--json` and in the text output. A slice blocked by a slice
whose PR is open is not held back. Such a ready slice lists that PR as `stackParents` in `--json`,
and the text output names it as `stack on <id> #<number>`. A task blocker never clears this way.
