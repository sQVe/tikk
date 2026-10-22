---
'tikk': minor
---

Add `tikk pr link`, `tikk reconcile`, and `tikk audit`. `tikk pr link` ties a slice to a GitHub PR.
`tikk reconcile` reads PR facts with `gh`, and `ready` and `needs` run it first. `tikk audit`
records one verdict for each criterion of a slice for a code state. `tikk show` and `tikk needs` now
show a slice as `inReview`, `mergedUnverified`, or `done`, and flag a merged slice that has open
tasks.
