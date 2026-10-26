---
'tikk': minor
---

Add plans, slices, and issues. `tikk new` creates every kind with criteria, ranks, and edges, and
refuses a parent the tree does not allow or a link to a ticket that does not exist. `tikk close`
closes an issue, and `tikk cancel` cancels a plan, slice, instruction, or issue.
`tikk edit --kind slice|plan` turns an issue into a slice or plan in place, with `--parent` for a
slice and `--criteria-file` for its criteria. An open plan or slice needs criteria. Every status
change tikk writes appends a `status` fact.

tikk now archives a plan or stand-alone ticket 14 days after it finishes. It sets `archived: <date>`
on the ticket and on the plan's slices and instructions, and files never move. `ls` and `ready`
leave archived tickets out, and `ls --archived` lists them. `tikk archive <id>` and
`tikk unarchive <id>` set and clear the field on a ticket and its descendants. An unarchived ticket
is not archived again for the same finish.

`tikk ready --parent <plan>` returns the plan's slices whose blockers are cleared, in rank order,
and names what blocks each slice it skipped. `ready --kind slice` does the same for every slice.
`ready --parent <slice>` still returns that slice's instructions. A canceled or closed plan or slice
no longer blocks a ticket that depends on it.

`tikk claim` and `tikk submit` now check the instruction's parent and links like `tikk close` does,
and refuse an instruction that points at a ticket that does not exist. `claim`, `submit`, and
`close` accept `--force --reason <text>` to skip that check. The reason is recorded on the fact they
append. `--force` needs `--reason`, and `--reason` needs `--force`.
