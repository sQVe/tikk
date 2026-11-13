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
2. `tikk ready --parent <plan> --json` returns the first slice as a candidate, and lists the
   second as skipped with the first as its blocker.
3. `tikk claim <first> --json` returns the claim and its `leaseEnd`. The same command with
   another `TIKK_AGENT` exits with 1 and the code `claimed`.
4. `tikk new --file instruction.md --json` creates an instruction under the first slice, and
   `tikk done <instruction>` marks it done. `tikk show <first> --json` lists the instruction as
   done and a later `leaseEnd`.

## End state

The store holds the plan, its two slices, and the done instruction under the first slice.
`tikk show <first> --json` returns a `claim` held by the manager in the state `claimed`, with a
`leaseEnd` later than the one `tikk claim` returned. `tikk show <second> --json` returns the first
slice in `blockedBy`.
