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
4. `tikk cancel <windows task> --reason "Linux and macOS only"`. `tikk show` of it has the status
   `canceled` and the reason. `tikk cancel` without `--reason` exits with 2.
5. `tikk rank <import task> --first`. `tikk ls --parent <plan>` lists the import task first.
6. `tikk block <lease task> <import task>`. `tikk show <lease task>` lists the import task as its
   blocker. `tikk block <import task> <lease task>` exits with 1 and names the cycle.

## End state

A store exists at `TIKK_HOME` with a plan and three tasks under it. `tikk ls --parent <plan> --json`
lists the import task first, then the lease and Windows tasks in the order of their IDs, because
step 5 ranks the other siblings in the order they had. `tikk ls --search lease --json` lists only
the lease task. The import and lease tasks are `open`, and
the Windows task is `canceled` with the reason "Linux and macOS only". `tikk show <lease task>
--json` lists the import task in `blockedBy`.
