---
'tikk': minor
---

Add `--covers <criterion>` and `--clear-covers` to `tikk edit`. `--covers` replaces the list of
criteria that a slice or an instruction covers. Every name must be a criterion of the parent, and a
slice with no parent cannot set it. `--clear-covers` removes the list, so an instruction with no
`covers` covers all of its slice's criteria again.
