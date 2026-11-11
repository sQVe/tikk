# ADR 0004: Toolchain, dependencies, and quality gates

**Date**: 2026-11-04\
**Status**: Accepted\
**Related**: [ADR 0002 (Native Rust app with GPUI, as two binaries over one core crate)](./0002-native-rust-gpui-two-binaries.md),
[ADR 0005 (Typed results for expected failures, panics for bugs, and parse-once
boundaries)](./0005-results-panics-and-parse-once-boundaries.md)

## Context

tikk starts as a Rust workspace, so it must choose its toolchain, formatting, linting, dependency
policy, and license checks before code exists. Every machine and CI run must give the same result
for the same code. Every dependency must have a license that allows an MIT app.

## Decision

tikk pins a stable Rust toolchain, formats with default rustfmt, lints with selected clippy lints,
locks its dependencies, checks them with cargo-deny, and runs `cargo xtask check` as the one entry
point for every check.

### Toolchain

- `rust-toolchain.toml` pins one stable release, with clippy and rustfmt. Every developer and CI
  build with that release. Moving to a newer release is a deliberate change.
- Every crate uses edition 2024.

### Formatting

- rustfmt runs with its default settings. tikk does not change the line-breaking widths.
- rustfmt never adds the blank lines between logical steps, so review checks them.

### Linting

- Clippy lint levels live in `[workspace.lints]`, and every crate uses them.
- The `all` group warns and `correctness` denies. Single lints, such as `dbg_macro` and `todo`, are
  added when they are needed. The whole pedantic, nursery, and restriction groups stay off.
- `print_stdout` and `print_stderr` warn on printing outside deliberate command output.
  `allow_attributes_without_reason`, `should_panic_without_expect`, and `redundant_clone` check
  lint reasons, panic expectations, and needless clones.
- A suppression is `#[expect(lint, reason = "...")]` on the smallest item that needs it. Use
  `#[allow(lint, reason = "...")]` only when the lint fires in some builds but not others.
- Unsafe code is denied.
- CI fails on any warning.

### Dependencies

- Manifests declare semver ranges, not exact pins.
- `Cargo.lock` is committed. Every Cargo build runs with `--locked`, so a stale lock file fails the
  build. The lock file fixes the versions that ship.
- Prefer the standard library to a crate. A new crate needs a stated reason.
- `xtask` uses `anyhow` to keep error causes, `thiserror` for errors callers distinguish, and
  `tempfile` to clean up test fixtures even after a failed assertion.
- CI pins cargo-mutants because its exit codes and report format are part of the automation
  contract. This tool pin is separate from library dependency ranges.

### Licenses

- tikk is MIT. The vendored gpui-component keeps its Apache-2.0 license and notices.
- cargo-deny checks licenses, advisories, sources, and duplicate crates. It allows Apache-2.0 and
  other licenses compatible with an MIT app, and rejects GPL.

### Tests and checks

- cargo-nextest runs the tests, and doctests run separately.
- `cargo xtask check` runs rustfmt, typos, taplo, cargo-deny, cargo-shear, clippy, nextest,
  doctests, rustdoc, and a crate-boundary check. It reports every failed check at the end and
  changes no files.
- The crate-boundary check fails when `tikk-cli` or `tikk-core` depends on GPUI, `tikk-ui`, or
  `tikk-desktop`, directly or through another crate. It reads the dependency graph from
  `cargo metadata`.
- prek runs formatting and linting as Git hooks before a commit.

### Mutation testing

- cargo-mutants includes `xtask`, so the checks themselves must have tests that catch false passes.
  `.cargo/mutants.toml` excludes entry points, tests, and test helpers, with a reason per exclusion.
- Pull requests mutate changed lines. Scheduled and manual runs on `main` audit the whole
  workspace and save the cargo-mutants report.
- Survivors are advice and do not fail CI. Errors, unmutated files, and failing baselines do.
  [ADR 0027](./0027-advisory-mutation-testing.md) records the mutation policy.

## Consequences

### Positive

- Every machine builds with the same compiler, so a lint or format result does not change between
  developers and CI.
- The lock file fixes what ships, and a manifest change shows in review.
- A GPL dependency or an unknown source fails the build before it ships.
- One command runs every check.

### Negative

- Default rustfmt keeps short calls, chains, and `if`/`else` blocks on one line, so code is more
  compact than some readers like.
- A pinned toolchain must be moved forward by hand, or tikk falls behind stable Rust.
- Selected lints catch less than the pedantic group, so some style problems are left to review.
- A new license in the dependency tree blocks the build until someone reviews and allows it.
- Hooks add time to each commit, and prek is one more tool to install.

## Alternatives considered

### Loosened rustfmt widths

Lower rustfmt's width settings so calls, chains, and `if`/`else` blocks split sooner. Rejected
because it adds config that differs from the Rust code readers know, and the default was acceptable.

### The whole clippy pedantic group

Turn on every pedantic lint and allow the ones that do not fit. Rejected because it brings many
lints that would each need an allow, and few mature Rust projects turn on the whole group.

### A floating stable toolchain

Build with whatever stable release is installed. Rejected because a new release can add lints or
change formatting, so the same code passes on one machine and fails on another.

### Exact version pins in manifests

Pin every dependency to one exact version in `Cargo.toml`. Rejected because each update becomes a
manifest edit, and the lock file already fixes the shipped versions.

### No license and advisory checks

Rely on review to catch a bad dependency. Rejected because the license of a transitive dependency is
easy to miss.
