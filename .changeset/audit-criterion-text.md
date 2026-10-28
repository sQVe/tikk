---
'tikk': patch
---

An audit no longer counts after a criterion's check or expected text changes, so the slice shows as
merged but unverified until a new audit runs.

`tikk audit` takes `--hash` with the ticket hash from `tikk show`, and it refuses a ticket changed
since that hash.
