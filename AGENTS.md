# tikk

Local ticket tracker for Tau, with a CLI for agents and a TUI for the user. Read
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
- Add a changeset with `bun run changeset` for user-facing changes.
- Before finishing a document, check its local links and verify the commands it gives against the
  repository.

## Architecture

- `src/` holds capability modules with one public entry file per folder. The first change that adds
  modules sets the import table in a local lint rule. Once it exists, do not silence it. Put types
  beside the code that owns them. Do not add barrels, a shared `types.ts`, or `utils/`. See
  [ADR 0006](docs/adr/0006-capability-modules.md).
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
