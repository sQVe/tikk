# ADR 0036: tikk keeps only its own rules beside the shared guides

**Date**: 2026-11-18\
**Status**: Accepted\
**Supersedes**: ADR 0030 (A Rust coding guide adapts Tau's coding rules)\
**Related**: [Shared coding guide](../stomme/shared/coding.md), [Rust guide](../stomme/languages/rust/guide.md), [GPUI guide](../stomme/layers/gpui/guide.md)

## Context

Agents write most of tikk's code. stomme syncs a shared coding guide, a Rust guide, GPUI layer
guides, and shared ADRs into `docs/stomme/`, and they state most of the rules tikk's own coding
guide and code-structure ADRs held. A project copy of a shared rule drifts when the shared rule
changes.

A few rules have no shared equivalent. They name tikk's crates, files, and resources, which the
shared guides never name.

## Decision

tikk keeps no coding guide of its own. The shared guides and ADRs state its coding rules, and this
ADR holds the rules that are tikk's own.

### Command output

Printing is allowed in `tikk-cli`, `tikk-scene`, and `xtask` only on the item that writes command
output, with a lint expectation that states the reason. The scene binary's list and readiness output
are command protocols, so they count as command output. The print lints of
[ADR 0004](./0004-toolchain-and-quality-gates.md) then catch stray output everywhere else, which
would otherwise mix with the JSON that agents read on standard output.

### xtask errors

`xtask` counts as app code. Its tasks report errors with `anyhow` and context, because a task only
passes the error to the person who ran it. An `xtask` error that a test tells apart gets a
`thiserror` type, because the test matches a variant instead of message text.

### Test folders

In `xtask`, a test gets its file system folder through `xtask/src/test_support.rs`, so the crate
keeps one helper. Tests in other crates take their folder from `tempfile` directly.

### State and resources

Code is pure and immutable by default. A struct with `Drop` is only for a resource tikk owns that
needs a release step, such as the store lock. `Drop` runs without a call site, so an effect there is
easy to miss. GPUI owns desktop UI state through its own entities.

### Parsing

tikk decodes ticket files, fact lines, config, and `gh` output with serde, then checks their meaning
with domain validation. Both happen once, where the data enters. serde gives every input one decoder
with typed errors instead of hand-written parsers.

### Names

- A function name starts with a verb, so a reader tells an action from a value.
- A view file starts with the owner it shows, such as `claim_row.rs` for a claim row. The core,
  CLI, and desktop files of one owner then share a prefix.

### Documents outside `docs/`

[Shared ADR 0001](../stomme/shared/adr/0001-documentation-scope.md) lets a project keep other
documents that explain no feature. tikk keeps two:

- The QA guide in `.pi/qa.md` tells an agent how to reach each interface, use it safely, and see
  that it works. It names only the visible results such a check needs.
- `vendor/gpui-component/PATCHES.md` records each local patch to the vendored copy beside that
  code, as [ADR 0003](./0003-vendored-gpui-component.md) decides.

`stomme.toml` has no field that lists such documents, so this ADR lists them.

### Rules held elsewhere

Every other rule of tikk's former coding guide and code-structure ADRs is stated by the shared
guides, the shared ADRs, or a kept tikk ADR.

## Consequences

### Positive

- Each coding rule has one home, so a shared change does not leave a project copy behind.
- The rules that are tikk's own keep a written reason.

### Negative

- A reader must follow the shared guides and this ADR to know every tikk rule.
- Most of these rules cannot be checked by a lint, so review must check them.

## Alternatives considered

### Keep a project coding guide for these rules

Keep a short project guide that holds only tikk's rules. Rejected because a project guide beside
the shared guides drifts, and the rules fit one short ADR.

### Put the rules in `AGENTS.md`

State the rules in the agent instructions. Rejected because instructions say what to do, while an
ADR keeps the lasting reason beside the rule.

### Rely on the shared guides alone

Drop the rules that the shared guides lack. Rejected because each one names a tikk crate, file, or
resource, so no shared rule can replace it.
