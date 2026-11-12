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

### Linux build packages

GPUI needs ALSA, Fontconfig, FreeType, OpenSSL, Vulkan, Wayland, X11, XCB, xkbcommon, and
pkg-config development packages. The Linux build and mutation jobs in
`.github/workflows/ci.yml` list the Debian and Ubuntu package names. The end-to-end job lists
Arch Linux packages, including the sandbox tools.

## Workspace

- `crates/tikk-core` holds the ticket model, storage, and actions. It never depends on GPUI, so it
  builds and tests without a display or GPU.
- `crates/tikk-cli` builds the `tikk` binary, the agent CLI. It never depends on GPUI or
  `tikk-ui`. `cargo run --locked -- --help` prints its help.
- `crates/tikk-ui` holds the GPUI views, theme, shared parts, and mock scenes. It builds the
  `tikk-scene` binary with `gpui-kit`. Its kit module is the only gpui-component import boundary.
- `vendor/gpui-component` is the published crate, wired through `[patch.crates-io]`, with
  no local patches. `PATCHES.md` records the source and patch rules. It is not a workspace member.
- `crates/tikk-desktop` builds the `tikk-desktop` binary, the desktop app. `cargo run --locked -p
  tikk-desktop` runs its stub. It does not open a window yet.
- `xtask` holds repository tasks, run as `cargo xtask <task>`.

## Check your work

Run every check before you open a pull request:

```sh
cargo xtask check
```

It changes no files. It runs rustfmt, typos, taplo, cargo-deny, cargo-shear, clippy, nextest,
doctests, rustdoc, the raw-value check, the crate-boundary check, and the module table check, and
reports every failed check at the end.
Warnings fail clippy, the tests, and rustdoc. Every Cargo build runs with `--locked`, so a stale
`Cargo.lock` fails too.

The crate-boundary check fails when `tikk-cli` or `tikk-core` depends on GPUI, `tikk-ui`, or
`tikk-desktop`, directly or through another crate. It prints the dependency path it found.

The module table check reads every top-level module of `crates/tikk-core/src/`, except `lib.rs`.
It reads paths that start with `crate::` in `use` items and in code, and skips comments and
strings. It fails when a module uses a module that its table entry does not allow, or when the
table does not list a module. It prints one line per problem, with the module and the file path,
and the line for a forbidden use. A new module or a new use between modules needs a change to the
table in `xtask/src/module_table.rs`.

The raw-value check scans `crates/tikk-ui/src/`, except its top-level `theme.rs`. Sizes, spacing,
radii, text sizes, and colors must use theme tokens or kit defaults. Run this check alone with
`cargo xtask raw-values`.

The theme's contrast test checks text against each surface at 4.5:1 and control boundaries at
3:1. It fails for a new failing pair or a known failing pair that starts to pass. The initial
known-failure list is empty.

`cargo xtask check tidy` runs only the checks that do not compile code, the crate-boundary check
and the module table check included. `cargo xtask check build` runs only the ones that do.

Fix problems with these commands:

| Problem | Command |
|---|---|
| Rust formatting | `cargo fmt --all` |
| TOML formatting | `taplo fmt` |
| Spelling | `typos --write-changes` |
| Unused dependencies | `cargo shear --fix` |
| Some clippy warnings | `cargo clippy --workspace --all-targets --locked --fix --allow-dirty --allow-staged` |

The pre-commit hook runs rustfmt, clippy, typos, and taplo, but only in check mode. Run the fix
commands yourself.

## UI mocks

The single `placeholder` scene uses shared parts and fake data. It proves the capture and judge
procedure, not tikk's visual direction. Scenes live in `crates/tikk-ui/src/scenes/`; shared parts
live in `crates/tikk-ui/src/parts.rs`.

Capture the scene:

```sh
cargo xtask mock capture placeholder
```

This builds and validates the scene, removes stale capture files, and asks ruta to write
`shot.png`, `crop.png`, and `capture.json` under `.tau/judge/placeholder/`. The crop is the scene
panel; the full shot includes the surrounding window. Capture uses a separate private display
and leaves a running interactive sandbox alone. `.tau/` is Git-ignored.

Use [judge-mock](../.pi/skills/judge-mock/SKILL.md) after a passing check. It runs two independent
judges and supports repeated improvement rounds through its hill-climb mode.

## Sandbox

Install ruta with the pinned command in [judge-mock](../.pi/skills/judge-mock/SKILL.md).
The same release is pinned in the end-to-end CI job.

Sandbox and capture run on Linux. Install Weston with its headless backend, Xwayland, xdotool,
ImageMagick with `magick` and `import`, fonts, and a Vulkan driver. Mesa's software Vulkan driver works without a GPU.
CI uses an Arch Linux container for the end-to-end test and installs the packages in its job.

Run scenes only on the private display, never against the real display:

```sh
cargo xtask sandbox up placeholder
cargo xtask sandbox shot
cargo xtask sandbox click 200 124
cargo xtask sandbox type "hello"
cargo xtask sandbox key Escape
cargo xtask sandbox log
cargo xtask sandbox opened
cargo xtask sandbox restart
cargo xtask sandbox down
```

The wrapper builds `tikk-scene` for `up` and `restart`, then passes arguments to ruta. Other
commands go straight to ruta. `ruta.toml` fixes the title, 640x480 window, and program path
`target/debug/tikk-scene`. Remove Cargo target directory overrides when using the sandbox.

The default sandbox root is `/var/tmp/ruta-tikk`. `RUTA_NAME` selects a separate sandbox name.
ruta supplies a private display and runtime environment. It stubs link openers instead of opening
links on the desktop. `down` removes the sandbox and its processes.

Run the ignored end-to-end tests with the same tools installed:

```sh
cargo nextest run --locked -p xtask --run-ignored only --test sandbox_end_to_end
```

## Mutation testing

Mutation testing changes the code in small ways and reports each change that no test catches.
`cargo xtask mutation` runs [cargo-mutants](https://mutants.rs) and prints one JSON report on stdout
in the format Tau's `mutation_check` tool reads.

```sh
cargo xtask mutation changed origin/main

cargo xtask mutation audit crates/tikk-core/src/lib.rs

cargo xtask mutation changed origin/main --max-mutants 50
```

`.cargo/mutants.toml` includes `xtask` and leaves out the `tikk` entry point, `tikk-desktop`, the
scene binary, fake scene data, vendor code, tests, and test helpers. Each exclusion states its
reason. Review each survivor and add a test when it
exposes missing coverage. The command exits 0 when every mutant is caught, no mutant matches, or
survivors remain in audit mode. It exits 2 for survivors in changed mode, and 1 for an error or an
unmutated file. cargo-mutants writes its logs to `target/mutants/mutants.out`.

## CI

`.github/workflows/ci.yml` runs on pull requests to any base branch, on pushes to `main`, weekly,
and on manual dispatch. The weekly run catches new security advisories without a code change.

- `Check` runs `cargo xtask check tidy` on Linux.
- `Test (Linux)` and `Test (macOS)` run `cargo xtask check build`. Linux installs GPUI system
  packages. tikk does not support Windows; see [ADR 0029](adr/0029-linux-and-macos-only.md).
- `End to end (Linux)` installs ruta and runs the ignored sandbox tests in an Arch Linux container.
  Failed runs upload sandbox logs and captures.
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
