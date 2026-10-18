# tikk

A local ticket tracker for coding agents and the people who run them. Agents use the CLI, and people
use a TUI and their editor. tikk is built first for [Tau](https://github.com/sQVe/tau), but any
agent or script can use its `--json` commands.

```sh
bun install
bun run build
./dist/tikk --version
bun run check
```

See [the documentation](docs/README.md) for the development guide and architecture decisions.
