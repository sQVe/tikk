# ADR 0025: `tikk needs` holds the attention query

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0017 (A disposable SQLite cache)](./0017-disposable-sqlite-cache.md)

## Context

The user cannot see in one place what needs them. The TUI should open on that view. Agents and
scripts need the same list.

## Decision

`tikk needs` and `tikk needs --json` hold the attention query, and ship before the TUI. The TUI is a
thin view over that query. It does no attention logic of its own. It can act on a listed item, such
as closing or accepting it, through the same code as the CLI command. `e` opens a ticket in
`$EDITOR`, and the TUI edits no ticket text.

The "needs you" view lists drafts waiting for agreement, blocked findings, merged but unverified
slices, stale claims, unanswered worker questions, and new issues. Each item comes from
`tikk needs --json`.

## Consequences

### Positive

- `tikk needs` ships before the TUI, so agents and the user can use the attention list first.
- The TUI and agents see the same list.

### Negative

- The TUI cannot show anything the query does not return.

## Alternatives considered

### The TUI computes attention itself

Let the TUI query the cache directly. Rejected because the design wants one attention query that
agents read through `tikk needs --json` and the TUI only shows. Two copies of the logic could list
different items.

### Editing ticket text inside the TUI

Edit titles, bodies, or criteria in the TUI. Rejected because the user edits ticket files in Neovim.
Actions that change state, such as close or accept, stay in the TUI because they are one key and
have a CLI equal.
