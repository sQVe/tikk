---
'tikk': minor
---

`tikk needs` also lists an open task that blocks an unfinished ticket, a loose task that `tikk new`
created, and a draft plan while it waits for you. Add `tikk wait <id> [--text <text>]`, which marks
a draft plan as waiting for you, and `tikk wait <id> --done`, which clears the mark. `tikk wait`
refuses any ticket that is not a draft plan.
