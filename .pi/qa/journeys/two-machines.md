# Journey: two-machines

## Who

The user with a laptop and a desktop, each with its own store on one Git remote.

## Goal

See the same tickets on both machines.

## Test

`crates/tikk-cli/tests/journey_two_machines.rs`, with a local bare remote.

## Steps

1. `tikk init --remote <url> --machine laptop` on the laptop and
   `tikk init --remote <url> --machine desktop` on the desktop. Both exit with 0.
2. On the laptop, `tikk new` creates a plan and a slice, and `tikk sync --json` reports that it
   committed and pushed. On the desktop, `tikk sync`, then `tikk ls` lists both tickets.

## End state

`tikk ls --json` lists the same tickets on both machines.
