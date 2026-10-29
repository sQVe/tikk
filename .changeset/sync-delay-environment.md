---
'tikk': minor
---

Read the sync debounce and settle delays from `TIKK_SYNC_DEBOUNCE_MILLISECONDS` and
`TIKK_SYNC_SETTLE_MILLISECONDS`. Each takes whole milliseconds and defaults to 3000 and 2000. The
debounce must be at least 1000. An invalid value makes every command exit with an `invalidSyncDelay`
error before it runs.
