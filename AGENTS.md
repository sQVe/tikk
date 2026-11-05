# tikk

A local ticket tracker for AI agents. tikk has a desktop app for the user and a command line for
agents. Both use one shared core crate. Read [the development guide](docs/development.md) for local
setup and verification.

- Run `cargo xtask check` before finishing changes. `cargo xtask mutation changed <base>` runs
  mutation testing on the lines changed since `<base>`.
- Format with `cargo fmt`. rustfmt runs with its default settings.
- Follow the decisions in [docs/adr](docs/adr/README.md), and record new decisions there. Read that
  guide before adding or changing an ADR. When details of a decision change, edit its ADR in place
  in the same change. Do not write documents that explain how a feature works; see [ADR
  0001](docs/adr/0001-documentation-scope.md).
- Comment only what the code cannot say, such as a constraint or a workaround. Do not describe the
  code's history.
- Before finishing a document, check its local links and verify the commands it gives against the
  repository.

## Architecture

- tikk is two binaries from one workspace. `tikk` is the agent CLI and has no GPUI dependency.
  `tikk-desktop` is the desktop app, and `tikk open` starts it. Both use the shared core crate,
  which never depends on GPUI. See [ADR 0002](docs/adr/0002-native-rust-gpui-two-binaries.md).
- The CLI never prompts. Every command has `--json`, and the CLI and the desktop app run the same
  core code for each action. See [ADR 0010](docs/adr/0010-cli-contract-for-agents.md).
- The UI uses gpui-component from a vendored copy that tikk owns and patches. Record each local
  patch, with its reason, next to the vendored code. Only one module of the desktop app imports
  gpui-component. See [ADR 0003](docs/adr/0003-vendored-gpui-component.md).
- The toolchain is pinned in `rust-toolchain.toml`. Lint levels live in `[workspace.lints]`, and CI
  fails on warnings. Manifests use semver ranges, and every Cargo build runs with `--locked`. See
  [ADR 0004](docs/adr/0004-toolchain-and-quality-gates.md).
- The app is MIT. Never depend on a GPL crate. Keep the Apache-2.0 license and notices of vendored
  code. See [ADR 0004](docs/adr/0004-toolchain-and-quality-gates.md).
- Ticket, fact, and storage rules are in [ADRs 0011 to 0026](docs/adr/README.md#domain-and-storage).
- Every UI mock passes the two-family mock gate. See [ADR
  0028](docs/adr/0028-two-family-ui-mock-gate.md).
