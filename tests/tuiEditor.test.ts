import { afterEach, beforeEach, expect, it } from 'bun:test';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { cliEnvironment, createCliFixture } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';

interface Screen {
  lines: string[];
  alternate: boolean;
}

const entryPath = join(import.meta.dir, '..', 'src', 'index.ts');
const typedTitle = 'ZZZZ-typed-ZZZZ';
const editorReady = 'EDITOR-READY';

// Reads the new title from the terminal, so it gets the typed line only when the TUI gave up
// stdin and turned raw mode off.
const typingEditor = `#!/bin/sh
printf '${editorReady}\\n'
IFS= read -r title
sed -i "s/^title: .*/title: $title/" "$1"
`;

// Ignores SIGTERM, so only SIGKILL stops it.
const stuckEditor = (pidPath: string): string => `#!/bin/sh
printf '%s' $$ > '${pidPath}'
trap '' TERM
printf '${editorReady}\\n'
exec sleep 30
`;

const showCursor = '\u001b[?25h';
const columns = 100;
const rows = 20;

// Replays the cursor moves, clears, screen switches, and text of the output. Other escape sequences
// are skipped.
const sequencePattern =
  // oxlint-disable-next-line eslint/no-control-regex -- Terminal escape sequences start with ESC and end with BEL.
  /\u001b\[([0-9;?]*)([ -/]*[@-~])|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)|\u001b[^[\]]/y;

const emptyScreen = (): string[][] =>
  Array.from({ length: rows }, () => Array.from({ length: columns }, () => ' '));

const screenOf = (output: string): Screen => {
  const main = emptyScreen();
  let screen = main;
  let alternate = false;
  let row = 0;
  let column = 0;
  let index = 0;

  while (index < output.length) {
    sequencePattern.lastIndex = index;

    const sequence = sequencePattern.exec(output);

    if (sequence !== null) {
      const [whole, parameters = '', command] = sequence;

      if (command === 'H') {
        const [line = '1', cell = '1'] = parameters.split(';');

        row = Number(line || '1') - 1;
        column = Number(cell || '1') - 1;
      }

      if (command === 'J' && parameters === '2') {
        screen.splice(0, rows, ...emptyScreen());
      }

      if (parameters === '?1049') {
        alternate = command === 'h';
        screen = alternate ? emptyScreen() : main;
      }

      index += whole.length;

      continue;
    }

    const character = output[index] ?? '';
    const line = screen[row];

    if (character === '\r') {
      column = 0;
    } else if (character === '\n') {
      row = Math.min(rows - 1, row + 1);
    } else if (line !== undefined && column < columns) {
      line[column] = character;
      column += 1;
    }

    index += 1;
  }

  return { lines: screen.map((line) => line.join('')), alternate };
};

let fixture: CliFixture | undefined;

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const writeEditor = async (script: string): Promise<string> => {
  const editorPath = join(cli().home, 'editor.sh');

  await writeFile(editorPath, script);
  await chmod(editorPath, 0o755);

  return editorPath;
};

const waitFor = async (ready: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 10_000;

  while (!ready() && Date.now() < deadline) {
    await Bun.sleep(25);
  }

  invariant(ready(), `The terminal never showed ${what}.`);
};

const startTikk = (editorPath: string) => {
  const decoder = new TextDecoder();
  const terminal = { output: '' };

  const child = Bun.spawn(['bun', 'run', entryPath], {
    cwd: cli().home,
    env: { ...cliEnvironment(cli().home, cli().storePath), EDITOR: editorPath },
    terminal: {
      cols: columns,
      rows,
      data: (_terminal, data) => {
        terminal.output += decoder.decode(data, { stream: true });
      },
    },
  });

  const shows = (text: string): boolean =>
    screenOf(terminal.output).lines.some((line) => line.includes(text));

  const waitForScreen = (text: string) => waitFor(() => shows(text), `"${text}"`);

  const waitForOutput = (text: string, from: number) =>
    waitFor(() => terminal.output.slice(from).includes(text), `"${text}" in its output`);

  const type = (text: string): void => {
    child.terminal?.write(text);
  };

  const close = () => {
    child.kill('SIGKILL');
    child.terminal?.close();
  };

  return { child, terminal, shows, waitForScreen, waitForOutput, type, close };
};

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

beforeEach(async () => {
  fixture = await createCliFixture('tikk-tui-editor-');
  await cli().runChecked(['init']);
});

afterEach(async () => {
  await fixture?.cleanup();
});

it('lends the terminal to $EDITOR on e, shows the typed title in the tree, and exits 0 on q', async () => {
  const plan = await cli().runJson<{ id: string }>(['new', 'plan', 'aaaa', '--status', 'draft']);
  const tikk = startTikk(await writeEditor(typingEditor));

  try {
    await tikk.waitForScreen('Nothing needs you.');

    tikk.type('\t');
    await tikk.waitForScreen(`> ${plan.id}  aaaa  draft`);

    const beforeEdit = tikk.terminal.output.length;

    tikk.type('e');
    await tikk.waitForOutput(editorReady, beforeEdit);
    tikk.type(`${typedTitle}\r`);
    await tikk.waitForScreen(`> ${plan.id}  ${typedTitle}  draft`);

    tikk.type('\t');
    await tikk.waitForScreen('Nothing needs you.');

    expect(tikk.shows(typedTitle)).toBe(false);

    tikk.type('q');

    expect(await tikk.child.exited).toBe(0);
  } finally {
    tikk.close();
  }

  const shown = await cli().runJson<{ title: string }>(['show', plan.id]);

  expect(shown.title).toBe(typedTitle);
}, 30_000);

it('stops an editor that ignores SIGTERM at shutdown, restores the terminal, and exits', async () => {
  await cli().runJson(['new', 'plan', 'aaaa', '--status', 'draft']);

  const pidPath = join(cli().home, 'editor.pid');
  const tikk = startTikk(await writeEditor(stuckEditor(pidPath)));

  try {
    await tikk.waitForScreen('Nothing needs you.');

    tikk.type('\t');
    await tikk.waitForScreen('aaaa  draft');

    const beforeEdit = tikk.terminal.output.length;

    tikk.type('e');
    await tikk.waitForOutput(editorReady, beforeEdit);

    const editorPid = Number(await readFile(pidPath, 'utf8'));
    const stopping = Date.now();

    tikk.child.kill('SIGTERM');

    const exitCode = await tikk.child.exited;

    expect(Date.now() - stopping).toBeLessThan(6000);
    expect(exitCode).toBe(0);
    expect(isRunning(editorPid)).toBe(false);
    expect(screenOf(tikk.terminal.output).alternate).toBe(false);
    expect(tikk.terminal.output.endsWith(showCursor)).toBe(true);
  } finally {
    tikk.close();
  }
}, 30_000);
