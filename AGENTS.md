# tikk

Local ticket tracker for coding agents and the people who run them, with a CLI for agents and a TUI
for people. It is built first for Tau, but works without it. Read
[the development guide](docs/development.md) for local setup and verification.

- Run `bun run check` before finishing changes. It runs typechecking, lint with house style,
  formatting, Knip, and tests.
- Format with `bun run format`, and fix style with `bun run style:fix`. House style comes from
  `@sqve/seam`.
- Follow the decisions in [docs/adr](docs/adr/README.md), and record new decisions there. Read that
  guide before adding an ADR. Do not write documents that explain how a feature works; see
  [ADR 0001](docs/adr/0001-documentation-scope.md).
- Name values in camelCase and types in PascalCase. Never SCREAMING_CASE, not even for module
  constants.
- Declare a helper before the code that uses it. Join at most three checks in one condition, and do
  not mix `&&` with `||`; name the inner group instead.
- Comment only what the code cannot say, such as a constraint or a workaround. Do not describe the
  code's history.
- Add a changeset with `bun run changeset` when a change touches `src/**`. Release PRs are exempt;
  see [versioning](docs/development.md#versioning).
- Before finishing a document, check its local links and verify the commands it gives against the
  repository.

## Architecture

- `src/` holds capability modules with one public entry file per folder. Lint enforces the import
  table in [`scripts/lintRules.ts`](scripts/lintRules.ts); update it with a new module or import
  edge, and never silence it. Put types beside the code that owns them. Do not add barrels, a shared
  `types.ts`, or `utils/`. See [ADR 0006](docs/adr/0006-capability-modules.md).
- Facts under `facts/` are durable, append-only JSONL. Each line is versioned and never edited, and
  evidence is bound to the code state it saw. The SQLite index is a disposable cache rebuilt from
  tickets and facts. Never write secrets into facts. See
  [ADR 0015](docs/adr/0015-facts-in-per-machine-jsonl.md) and
  [ADR 0017](docs/adr/0017-disposable-sqlite-cache.md).
- Return typed results for expected failures, and throw only through `invariant()`. Parse untrusted
  data once with zod where it enters. See
  [ADR 0005](docs/adr/0005-results-exceptions-and-zod-boundaries.md).
- A module that needs I/O declares a record of the functions it uses, beside its own code. Run
  external tools as argument arrays. See [ADR 0007](docs/adr/0007-side-effect-function-records.md).
- One module owns the TUI renderer, signals, shutdown, and lending the terminal. See
  [ADR 0008](docs/adr/0008-terminal-lifetime-owner.md).
- Inside a module, put code in owner files named owner first, with the owner noun before the job,
  and keep coordinators to dispatch. See [ADR 0009](docs/adr/0009-owner-files-and-file-names.md).
- Every command has `--json` and never prompts. Tau calls only `tikk ... --json`. Every TUI action
  has a CLI equal. See [ADR 0010](docs/adr/0010-cli-contract.md).

## Tests

- Test behavior a caller can observe. Do not test wording, constants, types, or internal calls.
- Keep tests next to source. Cross-module and tooling checks go in `tests/`.
- Use temporary directories for fixtures and remove them when the test finishes.
- Never drop assertions or failure cases to save time.
