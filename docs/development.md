# Development

Set up a checkout and check changes before release.

## Local setup

Use the Bun version specified by `packageManager` in [package.json](../package.json). Bun is the
runtime, package manager, and test runner. Run these commands from the tikk checkout:

```sh
bun install --frozen-lockfile
bun run check
```

`bun install` also installs the Git hooks. The pre-commit hook runs the house-style and format
checks on staged files.

## Build

```sh
bun run build
./dist/tikk --version
```

`bun run build` compiles `src/index.ts` into the `dist/tikk` binary.

## Install the command

```sh
bun run install:local
```

This compiles tikk and copies the binary to `~/.local/bin/tikk`. Set `TIKK_INSTALL_DIR` to use
another folder. The folder must be on your `PATH`. Run the command again to update the installed
`tikk`.

The binary finds its store from `TIKK_HOME` or `~/.local/share/tikk`, never from the checkout.

## Check changes

| Command                                     | Use                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `bun run check`                             | Run typechecking, house style, formatting, Knip, and the full test suite. |
| `bun run test`                              | Run the full test suite.                                                  |
| `bun run test tests/compiledBinary.test.ts` | Run one test file.                                                        |
| `bun run test:changed`                      | Run tests affected by uncommitted changes.                                |
| `bun run style:check`                       | Check all lint rules, including house style, with `seam`.                 |
| `bun run style:fix`                         | Apply safe lint fixes with `seam --fix`, then format.                     |
| `bun run lint`                              | Run ordinary lint diagnostics, as editors do.                             |
| `bun run format`                            | Format files.                                                             |
| `bun run knip`                              | Find unused files, exports, and dependencies.                             |
| `bun run mutation changed origin/main`      | Mutate the lines changed since `origin/main` and print a JSON report.     |

House style comes from the [`@sqve/seam`](https://www.npmjs.com/package/@sqve/seam) package. Its
`seam` command turns on the house rules for its own lint run, so editors and `bun run lint` show the
ordinary rules only.

Style commands accept file paths, for example `bun run style:fix src/index.ts`. Rename bindings and
move helpers manually.

Configure linting, formatting, and staged checks in [vite.config.ts](../vite.config.ts). Local rules
for module boundaries and throws live in [scripts/lintRules.ts](../scripts/lintRules.ts); read them
before adding a module, changing an import edge, or deciding where a throw belongs. Run installed
command-line tools with `bunx --bun`, as the scripts do. The tools start with a Node shebang, so
without `--bun` they run on Node instead of Bun.

## Versioning

Add a changeset when a change touches `src/**`:

```sh
bun run changeset
```

Describe the behavior change for users. Commit the generated file under `.changeset/` with the
change it describes.

The [changeset check](../.github/workflows/changeset.yml) requires a changeset when a PR touches
`src/**`. It skips the check when the PR title is `chore: release version packages` or the head
branch is `changeset-release/main`, which covers the release workflow's version PR. Changes only to
docs, tooling, or dependencies do not need one.

The [release workflow](../.github/workflows/release.yml) opens version PRs and creates Git tags and
GitHub releases. tikk is private and is not published to npm.
