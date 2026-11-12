# ADR 0005: Typed results for expected failures, panics for bugs, and parse-once boundaries

**Date**: 2026-11-04\
**Status**: Accepted\
**Related**: [ADR 0002 (Native Rust app with GPUI, as two binaries over one core crate)](./0002-native-rust-gpui-two-binaries.md),
[ADR 0004 (Toolchain, dependencies, and quality gates)](./0004-toolchain-and-quality-gates.md),
[ADR 0030 (A Rust coding guide adapts Tau's coding rules)](./0030-rust-coding-guide.md)

## Context

Many agents call tikk at once, and each call must fail in a way the caller can read. A hand edit can
break a ticket file, and tikk must keep running when it does.

Data enters from ticket files, fact lines, config, and `gh` output. tikk keeps no cache, so it
parses this data on every read. None of it can be trusted until it is parsed.

Agents write much of the code, so the conventions must be explicit and easy to check in review.

A few values own resources that must be released exactly once, such as the store lock. Everything
else is data and functions over it.

## Decision

Expected failures return typed results, and bugs panic. tikk decodes untrusted data once, at the
boundary, and passes trusted types inward. Checks for impossible states run in every build.

### Errors

- A function that can fail in an expected way returns `Result` with an error enum that names the
  reason. A ticket file that fails to parse, a missing ticket, a refused claim, a failed `gh` call,
  and a missing tool are expected failures.
- `xtask` is the exception. Its tasks only report a failure to the developer, so they return
  `anyhow::Result` with context. An `xtask` error that a caller or a test tells apart still gets an
  error enum. [ADR 0030](./0030-rust-coding-guide.md) holds the reasons.
- `assert!` and `unreachable!` check states that must be impossible. They run in release builds too.
  Never use them to check input.
- Library code in the core crate does not panic on input. A CLI command reports an expected failure
  with a message and a nonzero exit code, and prints it as JSON when `--json` is set.

### Boundaries

- Decode ticket files, fact lines, config, and `gh` output with serde. Then check their meaning
  with domain validation. Do both once, where the data enters.
- IDs are newtypes with private fields. Each has one constructor that validates the value, so a
  value of the type is always valid.

### State and resources

- Code is pure and immutable by default.
- Use a struct with `Drop` only for a resource tikk owns that needs a release step, such as the
  store lock. GPUI owns desktop UI state through its own entities.

### Dependencies

- Manifests declare semver ranges, and `Cargo.lock` fixes the versions that ship. Builds run with
  `--locked`, as [ADR 0004](./0004-toolchain-and-quality-gates.md) requires. Exact pins are not
  used.

## Consequences

### Positive

- A caller sees each expected failure in the return type, and must handle it.
- A bug fails where it happens, in every build.
- Code inside a boundary trusts its types and needs no defensive checks.

### Negative

- Results add code at every call that can fail.
- Checks that run in release builds must stay cheap.
- Serde and domain validation add code at each boundary.

## Alternatives considered

### Panics for every failure

Use panics for every failure. Rejected because callers cannot see from a signature which failures to
expect, and a panic stops the whole process.

### Results for every failure, bugs included

Use typed results for every failure, bugs included. Rejected because impossible states would spread
checks through every caller, and a bug would read like an expected outcome.

### Assertions only in debug builds

Use assertions that run only in debug builds. Rejected because a broken state in a release build
would go on silently and fail later, far from its cause.

### Each caller parses its own input

Let each function check the raw data it receives. Rejected because each caller would repeat the
checks, and one caller would miss one.
