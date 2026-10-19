# ADR 0005: Results for expected failures, exceptions for bugs, and zod at boundaries

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0002 (Own repository on the shared project base)](./0002-shared-project-base.md)

## Context

Many agents call tikk at once, and each call must fail in a way the caller can read. A hand edit can
break a ticket file, and tikk must keep running when it does.

Data enters from ticket files, fact lines, config, `gh` output, and the cache. None of it can be
trusted until it is parsed.

Agents write much of the code, so the conventions must be explicit and easy to check in review.

A few values own resources that must be released exactly once, such as the SQLite handle. Everything
else is data and functions over it.

Every runtime dependency ships to every user. A version range would let a rebuild pick up new
dependency code that nobody reviewed.

Zeta and Phi make the same choices for the same reasons.

## Decision

Expected failures return typed results, and bugs throw. tikk parses untrusted data once, at the
boundary, with zod. Invariants are always on.

### Errors

- A function that can fail in an expected way returns a typed result with a reason. A ticket file
  that fails to parse, a missing ticket, a refused claim, a failed `gh` call, and a missing tool are
  expected failures.
- Throw only for bugs. A CLI command reports an expected failure with a message and a nonzero exit
  code.
- `invariant(condition, message)` checks states that must be impossible. It runs in every build.
  Never use it to check input.
- Code in `src/` throws only inside the invariant module. Test files are exempt.

### Boundaries

- Parse ticket files, fact lines, config, `gh` output, and cache rows with zod, once, where they
  enter. Pass trusted types inward.
- IDs are branded types. Each has one constructor and is parsed at the boundary.

### State and classes

- Code is pure and immutable by default.
- Use a class only for a resource tikk owns that needs a dispose step, such as the SQLite handle or
  an OpenTUI renderable.
- Do not use inheritance, except where OpenTUI requires it.

### Dependencies

- Prefer Bun built-ins to packages.
- Add a runtime dependency only with a stated reason. A core dependency needs an ADR.
- Pin every dependency to an exact version.

## Consequences

### Positive

- A caller sees each expected failure in the type and must handle it.
- A bug fails where it happens, in every build.
- Code inside the boundary trusts its types and needs no defensive checks.

### Negative

- Results add code at every call that can fail.
- Always-on invariants run in release builds, so they must stay cheap.
- zod is a runtime dependency that every boundary relies on.
- Behavior that would sit on a class lives in module functions, so a reader finds a value's
  operations by its module, not its type.

## Alternatives considered

### Exceptions for every failure

Use exceptions for every failure. Rejected because callers cannot see from a signature which
failures to expect, and a missed catch can stop a command.

### Typed results for every failure

Use typed results for every failure, bugs included. Rejected because impossible states would spread
checks through every caller, and a bug would read like an expected outcome.

### Development-only assertions

Use assertions that run only in development builds. Rejected because a broken state in a release
would go on silently and fail later, far from its cause.

### Packages with version ranges

Add packages freely with version ranges. Rejected because each package adds size and supply-chain
risk, and a range can change shipped code without review.

### Classes and inheritance

Use classes as the main unit of code, with inheritance for shared behavior. Rejected because state
and behavior mix, so code is harder to test without real resources, and base classes couple
unrelated modules.
