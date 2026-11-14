# Journey: what-waits-on-the-user

## Who

The user, while agents work on a plan.

## Goal

See in one list everything that waits on the user, and clear it.

## Test

`crates/tikk-cli/tests/journey_what_waits_on_the_user.rs`, with a fake `gh` and a local bare
remote. A lease ends through a stale-claim fixture: a second `claim` line with the same `at` as
the real claim and a `leaseEnd` in 2020. No command sets the clock.

## Steps

1. An agent runs `tikk ask <slice> --text "Which crate?"`. `tikk needs --json` lists the question
   with its text and item ID.
2. The user runs `tikk answer <slice> <item> --text "serde-saphyr"`. `tikk needs` no longer lists
   it, and the agent's `tikk show <slice> --json` returns the answer.
3. The user runs `tikk new task "Renew the domain"` with no parent. `tikk needs` lists it with
   `looseTask`. After `tikk move <task> --parent <plan>`, it does not.
4. An agent's claim on the slice has a lease that ended. `tikk needs` lists the slice with
   `staleClaim` and its holder. After the user's `tikk release <slice>` without `TIKK_AGENT`, it
   does not.
5. Another slice's PR merges with no audit, and `tikk pr refresh` runs. `tikk needs` lists that
   slice with `mergedUnverified` and its `prCheckedAt`. After an audit with `met` for every
   criterion at the PR's head, it does not.

## End state

`tikk needs --json` returns no items and no problems, and no `tikk needs` call starts `gh`.
