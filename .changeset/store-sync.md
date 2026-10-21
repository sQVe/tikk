---
'tikk': minor
---

Add `tikk sync` and `tikk init --remote <url>`. Sync commits the store, fetches, merges, and pushes
to its Git remote, and works offline. Facts from two machines merge with no conflict. When two
machines edit one ticket, sync stops, leaves no merge in progress, and names the file. Sync leaves a
ticket file out of the commit until it parses and has not changed for two seconds, and lists it as
`pending`. After a write, a store with an `origin` remote syncs in the background after a three
second delay. `tikk claim` fetches and merges first, so it sees claims made on other machines, and
still works offline.
