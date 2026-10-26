---
'tikk': minor
---

Add `tikk block <id> <blocker>` and `tikk unblock <id> <blocker>`. They add or remove one
`blockedBy` edge on an existing ticket. Block refuses a missing blocker, the ticket itself, and a
blocker that would form a cycle through `blockedBy` or parent links, and the error names the cycle.
