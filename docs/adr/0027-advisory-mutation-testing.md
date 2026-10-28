# ADR 0027: Advisory mutation testing of changed lines with the shared package

**Date**: 2026-10-19\
**Status**: Accepted\
**Related**: [ADR 0003 (Bun as runtime, package manager, test runner, and compiler)](./0003-bun-toolchain.md),
[`@sqve/mutation`](https://www.npmjs.com/package/@sqve/mutation)

## Context

Tests that pass do not show that they would fail when the code is wrong. Mutation testing changes
the code in small ways and reports each change that no test fails. Tau runs such a check on every
change through the `mutation.argv` command in `.pi/tau.json`, and skips it in a repository that has
none.

Sibling projects kept their own copies of a StrykerJS script, and the copies drifted within days.
The shared `@sqve/mutation` package now holds the script: the scope of changed lines, the JSON
report, and an ignorer for message wording. Each project keeps only its own Stryker policy.

tikk runs on Bun only. Stryker's own runners expect Node and Vitest or Jest.

## Decision

tikk runs mutation testing of changed lines with the `@sqve/mutation` package and Stryker's command
runner on `bun test`, and the CI job that runs it is advisory.

### Package and config

- The package and the Stryker packages are pinned dev dependencies. A fix reaches tikk through a
  version bump.
- `stryker.config.json` holds only tikk's policy: the `mutate` globs, the runner, and timeouts. The
  package adds its ignorer and `ignoreStatic`.
- `mutation.argv` runs `bunx --bun mutation`, so Stryker runs on Bun and needs no Node, as ADR 0003
  requires of other tools.
- Every test runs for each mutant, not only the tests in the mutated file's folder. tikk is new, and
  its cross-module tests in `tests/` are part of what kills mutants.
- The command runner runs the whole suite with `--bail` and uses no coverage. The CLI tests run tikk
  in a child process, so per-test coverage never sees the code they reach and would mark those
  mutants as not covered without running a test.

### CI job

- The `Mutation` job runs `mutation.argv` on the changed lines of each pull request.
- It is not a required check. Survivors show as a failed job, and the author decides whether to add
  a test or accept the survivor.
- `timeout-minutes` bounds the job, because the package has no mutant cap by default.

## Consequences

### Positive

- Tau's `mutation_check` and the CI job check every change from the first feature on.
- tikk keeps no copy of the script, so it does not drift from the other projects.
- One runtime still covers the tooling, the app, and the mutation run.

### Negative

- A change to the script needs a package release before tikk can use it.
- The job does not block a merge, so a survivor can land when nobody reads the job result.
- Running every test for each mutant gets slower as the suite grows. A surviving mutant costs one
  full suite run.
- The report names no test that killed a mutant, because the command runner sees one test.

## Alternatives considered

### Keep a local copy of the script

Copy the script into `scripts/`, as sibling projects did at first. Rejected because the copies
drifted within days and each project fixed the same problems on its own.

### Make the job a required check

Block a merge on any survivor. Rejected because some survivors are equivalent mutants that no test
can kill, and blocking on them would push authors to `// Stryker disable` comments in production
code.

### Use a Bun test runner plugin with per-test coverage

Run `@hughescr/stryker-bun-runner`, which reports each test and runs only the tests that cover a
mutant. Rejected because it records coverage only in the test process. Mutants that only the CLI
tests reach showed as survivors without a test run, even with `coverageAnalysis` set to `off`.

### Run the package on Node

Run `mutation` on Node, as its README describes. Rejected because tikk would need a second runtime
in CI and locally only for this job.
