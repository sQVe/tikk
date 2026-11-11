# Development

## Set up

1. Install [rustup](https://rustup.rs). The first `cargo` command in the repository installs the
   toolchain that `rust-toolchain.toml` pins.
2. Install the check tools:

   ```sh
   cargo install --locked cargo-nextest cargo-deny cargo-shear cargo-mutants typos-cli taplo-cli prek
   ```

3. Install the Git hooks:

   ```sh
   prek install
   ```

### Debugger builds

The `dev` profile keeps line tables for workspace crates and no debug info for dependencies.
Backtraces still show files and lines. To inspect local variables in a debugger, build with:

```sh
cargo build --workspace --profile debugging --locked
```

The binaries are in `target/debugging/`. Dependencies still have no debug info in this profile.
See [ADR 0031](adr/0031-dev-builds-keep-line-tables-only.md) for the reasons.

## Workspace

- `crates/tikk-core` holds the ticket model, storage, and actions. It never depends on GPUI, so it
  builds and tests without a display or GPU.
- `crates/tikk-cli` builds the `tikk` binary, the agent CLI. It never depends on GPUI or
  `tikk-ui`. `cargo run --locked -- --help` prints its help.
- `crates/tikk-ui` holds the GPUI views.
- `crates/tikk-desktop` builds the `tikk-desktop` binary, the desktop app. `cargo run --locked -p
  tikk-desktop` starts it.
- `xtask` holds repository tasks, run as `cargo xtask <task>`.

## Check your work

Run every check before you open a pull request:

```sh
cargo xtask check
```

It changes no files. It runs rustfmt, typos, taplo, cargo-deny, cargo-shear, clippy, nextest,
doctests, rustdoc, and the crate-boundary check, and reports every failed check at the end.
Warnings fail clippy, the tests, and rustdoc. Every Cargo build runs with `--locked`, so a stale
`Cargo.lock` fails too.

The crate-boundary check fails when `tikk-cli` or `tikk-core` depends on GPUI, `tikk-ui`, or
`tikk-desktop`, directly or through another crate. It prints the dependency path it found.

`cargo xtask check tidy` runs only the checks that do not compile code, the crate-boundary check
included. `cargo xtask check build` runs only the ones that do.

Fix problems with these commands:

| Problem | Command |
|---|---|
| Rust formatting | `cargo fmt --all` |
| TOML formatting | `taplo fmt` |
| Spelling | `typos --write-changes` |
| Unused dependencies | `cargo shear --fix` |
| Some clippy warnings | `cargo clippy --workspace --all-targets --locked --fix` |

The pre-commit hook runs rustfmt, clippy, typos, and taplo, but only in check mode. Run the fix
commands yourself.

## Mutation testing

Mutation testing changes the code in small ways and reports each change that no test catches.
`cargo xtask mutation` runs [cargo-mutants](https://mutants.rs) and prints one JSON report on stdout
in the format Tau's `mutation_check` tool reads.

```sh
cargo xtask mutation changed origin/main

cargo xtask mutation audit crates/tikk-core/src/lib.rs

cargo xtask mutation changed origin/main --max-mutants 50
```

`.cargo/mutants.toml` includes `xtask` and leaves out the `tikk` entry point, `tikk-desktop`, tests,
and test helpers. Each exclusion states its reason. Review each survivor and add a test when it
exposes missing coverage. The command exits 0 when every mutant is caught, no mutant matches, or
survivors remain in audit mode. It exits 2 for survivors in changed mode, and 1 for an error or an
unmutated file. cargo-mutants writes its logs to `target/mutants/mutants.out`.

## CI

`.github/workflows/ci.yml` runs on pull requests to any base branch, on pushes to `main`, weekly,
and on manual dispatch. The weekly run catches new security advisories without a code change.

- `Check` runs `cargo xtask check tidy` on Linux.
- `Test (Linux)` and `Test (macOS)` run `cargo xtask check build`. CI installs no display
  libraries. tikk does not support Windows; see [ADR 0029](adr/0029-linux-and-macos-only.md).
- `Mutation (changed)` runs `cargo xtask mutation changed` against the pull request's base commit,
  on pull requests only. It lists survivors in the step summary. The job has a one-hour timeout.
- `Mutation audit` runs `cargo mutants --workspace --test-tool nextest` on scheduled and manual
  runs on `main`. It uploads `mutants.out` as an artifact and has a three-hour timeout.

CI pins the cargo-mutants version in `.github/workflows/ci.yml`.
Survivors do not fail either job; tool errors, unmutated
files, and failing baselines do. The concurrency group includes the event name, so a push to
`main` does not cancel its scheduled audit.

Only runs on `main` save the build cache. Renovate updates dependencies, actions, and the toolchain
every Monday, after a release is three days old.
