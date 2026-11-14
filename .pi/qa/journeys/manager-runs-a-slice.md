# Journey: manager-runs-a-slice

## Who

A manager agent with `TIKK_AGENT` set, and the user, who merges the PR.

## Goal

Take a slice from ready to done, with no step that marks it done by hand.

## Test

`crates/tikk-cli/tests/journey_manager_runs_a_slice.rs`

## Steps

1. The user creates a plan and two slices with `tikk new --file`, each with one criterion, the
   second with the first in `blockedBy`. `tikk show <second> --json` lists the blocker and the
   criterion.

## End state

The store holds the plan and its two slices. `tikk show <second> --json` returns the first slice in
`blockedBy`, the plan as `parent`, and the slice's one criterion with its `id`, `check`, and
`expected`.
