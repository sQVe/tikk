---
'tikk': patch
---

When the terminal UI stops an editor and cannot list its processes, tikk now waits for the editor to
exit before it reports the cleanup failure. A stubborn editor still ends the wait after one second,
and the failure and exit code are unchanged.
