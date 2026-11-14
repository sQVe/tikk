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

## End state

The broken file stays as the user left it, and `tikk ls --json` still lists every other ticket
under `tickets`.
