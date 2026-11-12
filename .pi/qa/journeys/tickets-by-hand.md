# Journey: tickets-by-hand

## Who

The user at a shell, with no agent.

## Goal

Set up a store and keep a plan's to-dos in order.

## Test

`crates/tikk-cli/tests/journey_tickets_by_hand.rs`

## Steps

1. `tikk init`. It exits with 0, and a second `tikk init` reports that the store exists.

## End state

A store exists at `TIKK_HOME`. Another `tikk init` exits with 0 and reports that the store exists.
