# ADR 0011: `tikk needs` holds the attention query

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0006 (A disposable SQLite cache)](./0006-disposable-sqlite-cache.md)

## Context

The user cannot see in one place what needs them. The TUI should open on that view. Agents and
scripts need the same list.

## Decision

`tikk needs` and `tikk needs --json` hold the attention query, and ship before the TUI. The TUI is a
thin view over that query. It does no attention logic of its own. `e` opens a ticket in `$EDITOR`,
and the TUI has no editing.

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

### Editing inside the TUI

Edit fields in the TUI. Rejected because the user edits ticket files in Neovim.
