# Journey: trouble

## Who

The user and agents when something goes wrong.

## Goal

Each failure is named with what to fix, and no ticket is lost.

## Test

`crates/tikk-cli/tests/journey_trouble.rs`, with a local bare remote.

## Steps

1. A ticket file is broken by hand. `tikk ls --json` lists its path under `errors`, and
   `tikk show` of it exits with 1 and `parseError`.
2. The user edits a ticket after an agent's `tikk show`. The agent's `tikk write --hash <old hash>`
   exits with 1 and `changedOnDisk`, and the user's edit stays.
3. Another process holds the store lock for more than five seconds. `tikk show` exits with 1 and
   `locked`.
4. A manager stops, and its lease ends. The user's `tikk release <slice>` without `TIKK_AGENT`
   exits with 0, and `tikk ready` offers the slice again.
5. Two machines changed the same ticket. The second `tikk sync` exits with 1 and `conflict`, names
   the file, and the ticket keeps the local text.

## End state

The broken file stays as the user left it, the edited ticket file holds the user's edit, and
`tikk ls --json` still lists every other ticket under `tickets`. The released slice has no
`claim` in `tikk show --json`. The ticket of the conflict holds the local text, and no merge is in
progress.
