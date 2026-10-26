---
'tikk': minor
---

Add `tikk pr link`, `tikk reconcile`, and `tikk audit`. `tikk pr link` ties a slice to a GitHub PR.
`tikk reconcile` reads PR facts with `gh`, and `ready` and `needs` run it first. A PR read that
takes longer than 30 seconds stops and is reported as a problem. `tikk audit` records one verdict
for each criterion of a slice for a repository, head, base, and change hash. `tikk show` and
`tikk needs` now show a slice as `inReview`, `mergedUnverified`, or `done`, and flag a merged slice
that has open instructions.
