---
'tikk': minor
---

Rename the worker ticket kind from `task` to `instruction`. `tikk new instruction`,
`tikk ready --kind instruction`, and the other commands use the new name. An instruction must name a
slice as its parent, so `tikk new instruction` refuses a missing parent and a plan parent.
