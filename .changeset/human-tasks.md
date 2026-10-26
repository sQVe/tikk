---
'tikk': minor
---

Add `task` tickets for a person's to-do. A task can sit under a plan, under a slice, or with no
parent. Its status is `open`, `done`, or `canceled`, and it has no claim, log, or submit.

`tikk new task --json` with no parent marks the task `new: true`. Plain `tikk new task`, and a task
with a parent, do not. Marking a task done or canceled removes the flag.

`tikk review add` accepts a slice or an instruction only, and refuses other kinds.
