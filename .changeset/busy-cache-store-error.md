---
'tikk': patch
---

A command that reads the cache reports a `storeError` when another process keeps the cache busy
during its query. With `--json`, it prints the error as JSON instead of exiting with no output.
