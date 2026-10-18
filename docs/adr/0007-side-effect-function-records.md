# ADR 0007: Side effects as narrow function records

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0006 (Capability modules with an enforced import table)](./0006-capability-modules.md),
[ADR 0008 (One owner for terminal lifetime)](./0008-terminal-lifetime-owner.md)

## Context

tikk runs `git` and `gh`, reads and writes files, takes a store lock, and reads the clock. Tests
must run without a network, a GitHub account, or a second machine.

Tests of a refused action must show that no command ran and no file changed.

In Tau, adapter interfaces without a second implementation became scaffolding. lazygit's guide names
a "God Struct" of broad dependencies.

## Decision

Side effects reach a module as a narrow record of plain functions that the module declares for
itself. Each consumer names only the effects it uses, and tests pass fakes for those.

### Function records

- Each consumer declares the type of its record beside its own code. A claim, for example, needs
  only the lock, a file write, a fact append, and the clock.
- The entry point builds the production functions. Tests pass fakes, deferred promises, and a fake
  clock.
- No adapter interfaces, classes, or containers.
- Long-running effects accept an `AbortSignal`.

### External tools

- External tools run as argument arrays, never as shell strings.
- Git is the only sync mechanism, and `gh` supplies PR facts. tikk chooses the action and invokes
  the tool.

## Consequences

### Positive

- A function signature shows which effects a module can reach.
- Tests pass only the fakes a module uses, and record calls to assert after the action.

### Negative

- Two consumers of the same effect declare similar types.
- The entry point wires every record by hand.

## Alternatives considered

### Adapter interfaces, classes, or a service container

Use adapter interfaces, classes, or a service container. Rejected because each has one production
implementation, so the extra type adds no choice.

### One shared effects record

Use one shared record for the whole app. Rejected because every consumer could reach every effect,
and one type would couple all modules.

### Direct runtime calls and module mocks

Make direct runtime calls inside each module, replaced in tests with module mocks. Rejected because
tests would depend on module loading, and pure modules would gain I/O.
