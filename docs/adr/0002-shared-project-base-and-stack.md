# ADR 0002: Own repository on the shared project base

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [Seam](https://github.com/sQVe/seam)

## Context

Tau plans and tracks work in Linear, which is built for human teams. Agents are the main writers and
readers. The user wants a local tool with a CLI for agents and a TUI for the user.

Zeta and Phi are Bun and TypeScript terminal apps with the same maintainer. They share a toolchain,
CI, release flow, and house style. Moving between them needs no relearning.

## Decision

tikk lives in its own repository and ships its own binary. It uses the same base as Zeta and Phi.
Tau calls `tikk ... --json`. This keeps tikk usable without Pi and gives Tau a clear boundary.

### What is shared

- Runtime and language: Bun and TypeScript. `bun build --compile` produces the binary.
- UI and validation: OpenTUI React for the TUI and zod for ticket parsing. `bun:sqlite` is built
  into Bun and holds the cache.
- Tooling: vite-plus for lint and format, `@sqve/seam` for house style, and Changesets for releases.
  Shared files match Zeta and Phi, except for the project name and description.

### What stays local

- `package.json` holds no runtime dependency yet. Later changes add OpenTUI React and zod when code
  imports them.
- There is no local lint plugin yet.
- ADRs after 0001 and the architecture section of `AGENTS.md` belong to tikk.

## Consequences

### Positive

- A fix to tooling, CI, or house style is copied as is from the sibling projects.
- tikk works for any agent that can run a CLI, with or without Pi.

### Negative

- Nothing catches drift between the three repositories. The author of a change to a shared file must
  make it in each.
- Tau and tikk release separately, so Tau must call a tikk version that has the command it needs.

## Alternatives considered

### A module inside Tau

Build tikk as part of the Tau repository. Rejected because it would not be usable without Pi, and it
would blur the boundary between Tau and its ticket store.

### A different stack

Choose tools that fit tikk alone. Rejected because the shared base removes relearning and lets fixes
move between repositories.
