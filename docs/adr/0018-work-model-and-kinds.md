# ADR 0018: Plans, slices, instructions, and tasks

**Date**: 2026-10-18\
**Status**: Accepted

## Context

The Linear tree copies acceptance into each ticket and keeps evidence as comments. Tau needs one PR
per slice and worker assignments that agents read and update directly. It also needs an inbox for
work not yet shaped.

## Decision

A ticket has one of four kinds.

### Kinds

- `plan`: an agreed design and its criteria. Its status is `draft`, `open`, or `canceled`.
- `slice`: one branch and one PR, which covers criteria. Its status is `draft`, `open`, or
  `canceled`. The manager agent claims the slice.
- `instruction`: one agent's instructions under a slice. Its status is `open`, `done`, or
  `canceled`. It has no claim of its own; it is part of the slice's claimed work.
- `task`: a person's to-do. Its status is `open`, `done`, or `canceled`. It has no claim, log, or
  submit.

`parent` is fixed by kind: plan above slice above instruction. A plan has no parent. A slice's
parent must be a plan, and an instruction's parent must be a slice. A task sits under a plan or has
no parent; no task sits under a slice. A loose task, one with no parent, becomes a slice or plan in
place with the same ID. A loose task is found by its missing parent, so no flag such as `new: true`
marks it. The tool rejects other pairs, cycles, and missing targets, and its error names the field.
Criteria are required on plans and slices only, and no other kind holds them. An instruction covers
all of its slice's criteria unless it names some. `tikk review add` accepts a slice or an
instruction only.

## Consequences

### Positive

- Each kind has one job, and workers read their instruction directly.
- Coverage is a query over criteria, not copied text.

### Negative

- Agents must write criteria IDs and coverage links. They may pass the check but test nothing, so
  finish-slice and code-review keep their judgment.

## Alternatives considered

### A Linear-shaped tree

One file per ticket with acceptance copied into each. Rejected because it copies acceptance into
each ticket and keeps evidence as comments. Revisit if criteria IDs prove too costly for agents.

### The PR as the only record

Track work through PRs alone. Rejected because a PR cannot hold a plan before branches exist.

### An outcome graph only

Track outcomes as a graph. Rejected because it is hard to read and execute. Its shared checks live
on as criteria.
