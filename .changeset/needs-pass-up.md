---
'tikk': minor
---

List in `tikk needs` only what the manager passed up to you. Questions and submissions get a stable
item ID, which `tikk log --type question` and `tikk submit` print. Add
`tikk pass-up <id> --item <item>` to pass a question or the current submission up. A question that
nobody passed up shows in Needs after 30 minutes. A submission shows only after a pass-up.
`tikk log --type answer` now needs `--item` and refuses an item that is not an open question.
`tikk accept` records the submission it accepts. Add `tikk reject <id> --reason <text>`, which
reopens a submitted instruction and ends its claim. `tikk show` shows the latest rejection until the
next submission. Fact lines of questions, answers, submissions, and accepts now need an `item`.
