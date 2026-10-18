# ADR 0003: Bun as runtime, package manager, test runner, and compiler

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0002 (Own repository on the shared project base)](./0002-shared-project-base.md),
[OpenTUI runtime support](https://opentui.com/docs/getting-started/runtime-support/),
[OpenTUI testing](https://opentui.com/docs/core-concepts/testing/)

## Context

tikk renders its TUI with OpenTUI ([ADR 0004](./0004-opentui-react-tui.md)). OpenTUI's native
renderer needs Bun. On Node it needs an experimental FFI flag. Its testing docs use Bun.

With Node tooling, app tests would need a second runtime and test runner next to the tooling tests.

tikk keeps a cache in SQLite, and Bun has `bun:sqlite` built in. Agents call tikk as a CLI, so one
binary that needs no runtime of its own is easy to install.

## Decision

tikk uses Bun as its runtime, package manager, test runner, and compiler. `bun build --compile`
produces the one binary that agents and the user run. One runtime covers the tooling, the CLI, the
TUI, and every test.

### Toolchain

- `bun.lock` is the only lockfile. `packageManager` in `package.json` pins the Bun version, and CI
  installs that version.
- Tests use `bun test` and import from `bun:test`.
- Vite+ stays for lint, formatting, and staged checks. TypeScript, Knip, and Changesets also stay.
- Scripts and hooks run installed command-line tools with `bunx --bun`, so tools with a Node shebang
  run on Bun.
- The cache uses `bun:sqlite`, not a SQLite package.

## Consequences

### Positive

- The tooling, the app, and all tests share one runtime and one test runner.
- The cache needs no native SQLite package.

### Negative

- GitHub's dependency graph does not read `bun.lock`, so dependency review does not cover locked
  package versions.
- Tools that assume Node need `bunx --bun`, and a tool that fails on Bun has no Node fallback.
- Oxlint's test rules do not recognize `bun:test`, so test files get no test-specific lint.

## Alternatives considered

### Node, pnpm, and Vitest

Keep Node, pnpm, and Vitest. Rejected because app code and app tests cannot load OpenTUI on Node
without a second runtime.

### Node with experimental FFI

Move to a Node version that supports OpenTUI with experimental FFI. Rejected because it depends on
an experimental flag.
