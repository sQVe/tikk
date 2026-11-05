# ADR 0029: tikk supports Linux and macOS, not Windows

**Date**: 2026-11-05\
**Status**: Accepted\
**Related**: [ADR 0011 (One user, with no ownership, permissions, or assignees)](./0011-single-user.md), [ADR 0012 (One Git store per user with one lock)](./0012-one-git-store-with-one-lock.md)

## Context

tikk is two binaries, `tikk` and `tikk-desktop`, over one core crate. GPUI runs on Linux, macOS,
and Windows, because Zed ships a build for each. A platform that tikk supports needs its own code
paths, its own CI job, and its own bug reports.

tikk serves one user and their agents ([ADR 0011](./0011-single-user.md)), and keeps its store in a
Git repository ([ADR 0012](./0012-one-git-store-with-one-lock.md)). On Windows, that store meets
other path rules, CRLF line endings, `core.autocrlf` rewriting the files tikk reads, and file
locking that behaves differently. Each of these needs code and tests in tikk. Once the desktop app
builds GPUI, a Windows CI job would also run a full GPUI build on Windows, and no user of the
project needs it.

## Decision

tikk supports Linux and macOS, and does not support Windows. The reason is cost, not a broken
platform: Windows support would cost code, tests, and CI time that no user needs.

The rule covers both binaries:

- CI tests on Linux and macOS only.
- tikk's own crates hold no `cfg(windows)` code and no Windows path, line ending, or locking rules.
- A report of a problem on Windows is out of scope.
- The vendored gpui-component keeps its Windows code untouched, because tikk patches it only where
  tikk needs a change ([ADR 0003](./0003-vendored-gpui-component.md)).

## Consequences

### Positive

- The store code handles one family of path rules, line endings, and file locks.
- CI never runs a GPUI build on Windows.

### Negative

- Users on Windows cannot run tikk, except through a Linux environment such as WSL, which tikk
  does not test.
- Supporting Windows later means adding the platform code and CI job that this decision leaves out.

## Alternatives considered

### Support Linux, macOS, and Windows

Keep the Windows CI job and handle Windows paths, line endings, and locking in the store. Rejected
because no user of the project runs Windows, so the code and CI time buy nothing.

### Support Linux only

Drop macOS as well and test on one platform. Rejected because macOS has GPUI's most mature backend,
and its CI job already exists.
