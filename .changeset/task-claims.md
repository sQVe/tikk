---
'tikk': minor
---

Add `tikk claim`, `release`, `log`, `submit`, `accept`, `cancel`, and `ready`. A holder claims a
task with a lease, logs progress, and submits it for review, and `accept` marks it done. `ready`
lists open tasks that nothing blocks and names what blocks the rest. `tikk show` reports a task's
state and its active claim. Each write takes the store lock, so two agents cannot claim one task at
once.
