# ADR 0007: Side effects as narrow records of functions

**Date**: 2026-11-04\
**Status**: Accepted\
**Related**: [ADR 0006 (Capability modules with an enforced dependency table)](./0006-capability-modules.md),
[ADR 0008 (One owner for the desktop app's lifetime)](./0008-app-lifetime-owner.md)

## Context

tikk runs `git` and `gh`, reads and writes files, takes a store lock, and reads the clock. Tests
must run without a network, a GitHub account, or a second machine.

Tests of a refused action must show that no command ran and no file changed.

Adapter traits with one implementation add a type and no choice. A broad container of effects lets
every module reach every effect.

## Decision

Side effects reach a module as a narrow struct of functions that the module declares for itself.
Each consumer names only the effects it uses, and tests pass fakes for those.

### Function records

- Each consumer declares its struct beside its own code. A claim, for example, needs only the lock,
  a file write, a fact append, and the clock, so its struct holds those four functions.
- The entry point builds the production functions. Tests pass fakes and a fake clock.
- Do not use trait objects, service containers, or traits with one implementation.
- Long-running effects accept a cancellation signal of their own type, which the owner sets.

### External tools

- External tools run as argument lists through `std::process::Command`, never through a shell
  string.
- Git is the only sync mechanism, and `gh` supplies PR facts. tikk chooses the action and runs the
  tool.

## Consequences

### Positive

- A function signature shows which effects a module can reach.
- Tests pass only the fakes a module uses, and record calls to assert after the action.

### Negative

- Two consumers of the same effect declare similar structs.
- The entry point wires every struct by hand.

## Alternatives considered

### Adapter traits and a service container

Use adapter traits, or a container that holds every service. Rejected because each trait has one
production implementation, so the extra type adds no choice.

### One shared effects struct

Use one struct of effects for the whole app. Rejected because every consumer could reach every
effect, and one type would couple all modules.

### Direct calls with mocking crates

Make direct runtime calls inside each module, and replace them in tests with mocking crates.
Rejected because tests would depend on global state, and pure modules would gain I/O.
