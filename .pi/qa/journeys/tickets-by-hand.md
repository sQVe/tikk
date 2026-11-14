# Journey: tickets-by-hand

## Who

The user at a shell, with no agent.

## Goal

Set up a store and keep a plan's to-dos in order.

## Test

`crates/tikk-cli/tests/journey_tickets_by_hand.rs`

## Steps

1. `tikk init`. It exits with 0, and a second `tikk init` reports that the store exists.
2. `tikk new plan "Move to tikk"`, then `tikk new task <title> --parent <plan>` for "Decide the
   lease length", "Write the import note", and "Ask about Windows". Each prints its new ID.
3. `tikk ls --parent <plan>` lists the three tasks. `tikk ls --search lease` lists only the lease
   task.

## End state

A store exists at `TIKK_HOME` with a plan and three open tasks under it.
`tikk ls --parent <plan> --json` lists the three tasks, and `tikk ls --search lease --json` lists
only the lease task.
