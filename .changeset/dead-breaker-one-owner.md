---
'tikk': patch
---

When two processes find the same stale store lock left by a process that died while clearing it,
only one of them clears it and takes the store lock. Before, both could hold the lock at once.
