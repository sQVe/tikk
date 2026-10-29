import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { cliEnvironment } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';

interface Screen {
  lines: string[];
  alternate: boolean;
}

interface TerminalTikk {
  child: Bun.Subprocess;
  terminal: { output: string };
  shows: (text: string) => boolean;
  waitForScreen: (text: string) => Promise<void>;
  waitForSelected: (text: string) => Promise<void>;
  selectPlan: (text: string) => Promise<void>;
  waitForOutput: (text: string, from: number) => Promise<void>;
  type: (text: string) => void;
  close: () => void;
}

const entryPath = join(import.meta.dir, '..', 'src', 'index.ts');
const columns = 100;
const rows = 20;

const sequencePattern =
  // oxlint-disable-next-line eslint/no-control-regex -- Terminal escape sequences start with ESC and end with BEL.
  /\u001b\[([0-9;?]*)([ -/]*[@-~])|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)|\u001b[^[\]]/y;

const emptyScreen = (): string[][] =>
  Array.from({ length: rows }, () => Array.from({ length: columns }, () => ' '));

export const screenOf = (output: string): Screen => {
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

export const waitFor = async (ready: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 10_000;

  while (!ready() && Date.now() < deadline) {
    await Bun.sleep(25);
  }

  invariant(ready(), `The terminal never showed ${what}.`);
};

export const startTerminalTikk = (
  fixture: CliFixture,
  editorPath: string,
  environment: Record<string, string> = {},
  preload?: string,
): TerminalTikk => {
  const decoder = new TextDecoder();
  const terminal = { output: '' };

  const command = [process.execPath];

  if (preload !== undefined) {
    command.push('--preload', preload);
  }

  command.push(entryPath);

  const child = Bun.spawn(command, {
    cwd: fixture.home,
    env: { ...cliEnvironment(fixture.home, fixture.storePath), EDITOR: editorPath, ...environment },
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

  const waitForSelected = (text: string) =>
    waitFor(
      () =>
        screenOf(terminal.output).lines.some((line) => line.startsWith('>') && line.includes(text)),
      `"${text}" selected`,
    );

  const selectPlan = async (text: string): Promise<void> => {
    type('s');
    await waitForScreen(text);
    type('jj');
    await waitForSelected(text);
  };

  const close = () => {
    child.kill('SIGKILL');
    child.terminal?.close();
  };

  return {
    child,
    terminal,
    shows,
    waitForScreen,
    waitForSelected,
    selectPlan,
    waitForOutput,
    type,
    close,
  };
};

export const writeEditorScript = async (home: string, script: string): Promise<string> => {
  const editorPath = join(home, 'editor.sh');

  await writeFile(editorPath, script);
  await chmod(editorPath, 0o755);

  return editorPath;
};
