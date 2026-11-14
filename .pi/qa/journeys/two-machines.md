# Journey: two-machines

## Who

The user with a laptop and a desktop, each with its own store on one Git remote.

## Goal

See the same tickets on both machines, and never let two agents hold one slice.

## Test

`crates/tikk-cli/tests/journey_two_machines.rs`, with a local bare remote.

## Steps

1. `tikk init --remote <url> --machine laptop` on the laptop and
   `tikk init --remote <url> --machine desktop` on the desktop. Both exit with 0.
2. On the laptop, `tikk new` creates a plan and a slice, and `tikk sync --json` reports that it
   committed and pushed. On the desktop, `tikk sync`, then `tikk ls` lists both tickets.
3. On the laptop, one agent's `tikk claim <slice>` exits with 0. On the desktop, another agent's
   `tikk claim <slice>` exits with 1 and `claimed`, with no `tikk sync` call in between.
4. On the laptop, `tikk release <slice>`. On the desktop, the other agent's `tikk claim <slice>`
   exits with 0.

## End state

After `tikk sync` on the laptop, `tikk show <slice> --json` on both machines names the desktop's
agent as the holder, and `tikk ls --json` lists the same tickets on both.
