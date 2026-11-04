# ADR 0027: Advisory mutation testing of changed lines with cargo-mutants

**Date**: 2026-11-04\
**Status**: Accepted\
**Related**: [ADR 0004 (Toolchain, dependencies, and quality gates)](./0004-toolchain-and-quality-gates.md),
[cargo-mutants](https://mutants.rs)

## Context

Tests that pass do not show that they would fail when the code is wrong. Mutation testing changes
the code in small ways and reports each change that no test fails. Tau runs such a check on every
change through a command in its repository config, and skips it in a repository that has none.

tikk is a Rust workspace. A mutation tool that needs a second runtime would add a second toolchain
for one job.

## Decision

tikk runs mutation testing with cargo-mutants through `cargo xtask mutation`. The CI job that runs
it is advisory.

### Commands

- `cargo xtask mutation changed <base>` mutates the lines changed since a base ref. `cargo xtask
  mutation audit <paths>` mutates whole files.
- Both modes print one JSON report on stdout, in the format that Tau's `mutation_check` tool reads.
- The command exits 0 when every mutant is caught, 2 for survivors in changed mode, and 1 for an
  error or an unmutated file.
- Every test runs for each mutant, not only the tests near the mutated file. tikk's cross-module
  tests in `tests/` are part of what kills mutants.
- A surviving mutant is a survivor. The author decides whether to add a test that fails when that
  line changes, or to accept the survivor as equivalent.

### CI job

- The `Mutation` job runs `cargo xtask mutation changed <base>` on each pull request. `<base>` is
  the pull request's base branch, so the job mutates only the lines the pull request changes.
- It is not a required check. Survivors show as a failed job, and the author decides what to do.
- A job timeout bounds the run time, because the mutant count has no cap by default.

## Consequences

### Positive

- Tau's `mutation_check` and the CI job check every change, from the first feature on.
- The same command runs locally and in CI.
- One toolchain covers the build, tests, and mutation run.

### Negative

- The job does not block a merge, so a survivor can land when nobody reads the job result.
- Every test runs for each mutant, so runs get slower as the suite grows.
- Some survivors are equivalent mutants that no test can kill, so each one needs a judgment.

## Alternatives considered

### A mutation script on a second runtime

Run a JavaScript mutation tool beside the Rust build. Rejected because it needs a second toolchain
in CI and locally for this one job.

### Make the job a required check

Block a merge on any survivor. Rejected because some survivors are equivalent mutants, and blocking
on them would push authors to suppress mutants in production code.

### Run only the tests near the mutated file

Limit each mutant's test run to the tests in the same folder. Rejected because tikk's cross-module
tests in `tests/` are part of what kills mutants.
