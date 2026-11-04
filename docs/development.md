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

## Workspace

- `crates/tikk-core` holds the ticket model, storage, and actions. It never depends on GPUI, so it
  builds and tests without a display or GPU.
- `crates/tikk-cli` builds the `tikk` binary, the agent CLI. It never depends on GPUI or
  `tikk-ui`. `cargo run -- --help` prints its help.
- `crates/tikk-ui` holds the GPUI views.
- `crates/tikk-desktop` builds the `tikk-desktop` binary, the desktop app. `cargo run -p
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
| Some clippy warnings | `cargo clippy --workspace --all-targets --fix` |

The pre-commit hook runs rustfmt, clippy, typos, and taplo, but only in check mode. Run the fix
commands yourself.

## Mutation testing

Mutation testing changes the code in small ways and reports each change that no test catches.
`cargo xtask mutation` runs [cargo-mutants](https://mutants.rs) and prints one JSON report on stdout
in the format Tau's `mutation_check` tool reads.

```sh
cargo xtask mutation changed main

cargo xtask mutation audit crates/tikk-core/src/lib.rs

cargo xtask mutation changed main --max-mutants 50
```

`.cargo/mutants.toml` leaves out the `tikk` entry point, `tikk-desktop`, `xtask`, and test helpers.
A missed mutant is a survivor: add a test that fails when that line changes. The command exits 0
when every mutant is caught or no mutant matches, 2 for survivors in changed mode, and 1 for an
error or an unmutated file. cargo-mutants writes its logs to `target/mutants/mutants.out`.

## CI

`.github/workflows/ci.yml` runs on pull requests, on pushes to `main`, and weekly, so new security
advisories fail cargo-deny without a code change.

- `Check` runs `cargo xtask check tidy` on Linux.
- `Test (Linux)`, `Test (macOS)`, and `Test (Windows)` run `cargo xtask check build`. CI installs
  no display libraries.
- `Mutation` runs `cargo xtask mutation changed` against the pull request's base branch, on pull
  requests only. It is advisory: survivors fail the job, but it is not a required check.

Only runs on `main` save the build cache. Renovate updates dependencies, actions, and the toolchain
every Monday, after a release is three days old.
