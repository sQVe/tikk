# Journey: trouble

## Who

The user and agents when something goes wrong.

## Goal

Each failure is named with what to fix, and no ticket is lost.

## Test

`crates/tikk-cli/tests/journey_trouble.rs`

## Steps

1. A ticket file is broken by hand. `tikk ls --json` lists its path under `errors`, and
   `tikk show` of it exits with 1 and `parseError`.
2. The user edits a ticket after an agent's `tikk show`. The agent's `tikk write --hash <old hash>`
   exits with 1 and `changedOnDisk`, and the user's edit stays.
3. Another process holds the store lock for more than five seconds. `tikk show` exits with 1 and
   `locked`.

## End state

The broken file stays as the user left it, the edited ticket file holds the user's edit, and
`tikk ls --json` still lists every other ticket under `tickets`.
