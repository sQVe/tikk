import { afterEach, beforeEach, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
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

const stuckEditor = (pidPath: string): string => `#!/bin/sh
printf '%s' $$ > '${pidPath}'
trap '' TERM
printf '${editorReady}\\n'
exec sleep 30
`;

const wrapperEditor = (pidPath: string): string => `#!/bin/sh
(trap '' TERM; exec sleep 30) &
descendant=$!
printf '%s %s' $$ "$descendant" > '${pidPath}'
printf '${editorReady}\\n'
wait "$descendant"
printf reaped > '${pidPath}.reaped'
`;

const showCursor = '\u001b[?25h';
const columns = 100;
const rows = 20;

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

const writeSignalRefusal = async (pidPath: string): Promise<string> => {
  const preload = join(cli().home, 'refuse-signals.ts');

  await writeFile(
    preload,
    `
import { readFileSync } from 'node:fs';
const signalProcess = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (signal === 0) {
    return signalProcess(pid, signal);
  }

  const editorPid = Number(readFileSync(${JSON.stringify(pidPath)}, 'utf8'));

  if (pid !== editorPid) {
    throw new Error('Refusing to signal a process outside this fixture.');
  }

  throw Object.assign(new Error('Fixture signal denied.'), { code: 'EPERM' });
};
`,
  );

  return preload;
};

const waitFor = async (ready: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 10_000;

  while (!ready() && Date.now() < deadline) {
    await Bun.sleep(25);
  }

  invariant(ready(), `The terminal never showed ${what}.`);
};

const startTikk = (
  editorPath: string,
  environment: Record<string, string> = {},
  preload?: string,
) => {
  const decoder = new TextDecoder();
  const terminal = { output: '' };

  const command = [process.execPath];

  if (preload !== undefined) {
    command.push('--preload', preload);
  }

  command.push(entryPath);

  const child = Bun.spawn(command, {
    cwd: cli().home,
    env: { ...cliEnvironment(cli().home, cli().storePath), EDITOR: editorPath, ...environment },
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

    tikk.type('s');
    await tikk.waitForScreen(`> ${plan.id}  aaaa  draft`);

    const beforeEdit = tikk.terminal.output.length;

    tikk.type('e');
    await tikk.waitForOutput(editorReady, beforeEdit);
    tikk.type(`${typedTitle}\r`);
    await tikk.waitForScreen(`> ${plan.id}  ${typedTitle}  draft`);

    tikk.type('s');
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

it.skipIf(Bun.which('nvim') === null)(
  'lends the controlling terminal to Neovim through a non-exec wrapper',
  async () => {
    const plan = await cli().runJson<{ id: string }>(['new', 'plan', 'aaaa', '--status', 'draft']);
    const editorPath = await writeEditor('#!/bin/sh\nnvim --clean -n "$1"\n');
    const tikk = startTikk(editorPath);

    try {
      await tikk.waitForScreen('Nothing needs you.');

      tikk.type('s');
      await tikk.waitForScreen(`> ${plan.id}  aaaa  draft`);

      const beforeEdit = tikk.terminal.output.length;

      tikk.type('e');
      await tikk.waitForOutput('title: aaaa', beforeEdit);
      tikk.type(':%s/^title: .*/title: Neovim edit/\r:wq\r');
      await tikk.waitForScreen(`> ${plan.id}  Neovim edit  draft`);

      tikk.type('q');

      expect(await tikk.child.exited).toBe(0);
      expect(screenOf(tikk.terminal.output).alternate).toBe(false);
      expect(tikk.terminal.output.endsWith(showCursor)).toBe(true);
    } finally {
      tikk.close();
    }

    const shown = await cli().runJson<{ title: string }>(['show', plan.id]);

    expect(shown.title).toBe('Neovim edit');
  },
  30_000,
);

it('stops a non-exec editor wrapper and its descendant before restoring the terminal', async () => {
  await cli().runJson(['new', 'plan', 'aaaa', '--status', 'draft']);

  const pidPath = join(cli().home, 'editor-tree.pid');
  const tikk = startTikk(await writeEditor(wrapperEditor(pidPath)));
  let editorPids: number[] = [];

  try {
    await tikk.waitForScreen('Nothing needs you.');

    tikk.type('s');
    await tikk.waitForScreen('aaaa  draft');

    const beforeEdit = tikk.terminal.output.length;

    tikk.type('e');
    await tikk.waitForOutput(editorReady, beforeEdit);

    editorPids = (await readFile(pidPath, 'utf8')).split(' ').map(Number);

    expect(editorPids).toHaveLength(2);
    expect(editorPids.every(isRunning)).toBe(true);

    const stopping = Date.now();

    tikk.child.kill('SIGTERM');

    const exitCode = await tikk.child.exited;

    expect(Date.now() - stopping).toBeLessThan(6000);
    expect(exitCode).toBe(0);
    expect(editorPids.map(isRunning)).toEqual([false, false]);
    expect(await readFile(`${pidPath}.reaped`, 'utf8')).toBe('reaped');
    expect(screenOf(tikk.terminal.output).alternate).toBe(false);
    expect(tikk.terminal.output.endsWith(showCursor)).toBe(true);
  } finally {
    for (const editorPid of editorPids) {
      if (isRunning(editorPid)) {
        process.kill(editorPid, 'SIGKILL');
      }
    }

    tikk.close();
  }
}, 30_000);

it.each([
  ['the process list is unavailable', 'exit 1'],
  ['the process list is malformed', 'printf "invalid process list\\n"'],
  ['the process list is stalled', 'trap "" TERM\nexec /bin/sleep 30'],
  ['SIGTERM is refused', 'exec /bin/ps "$@"'],
])(
  'returns a typed cleanup failure and stops the editor when %s',
  async (name, script) => {
    const commandDirectory = join(cli().home, 'commands');
    const pidPath = join(cli().home, 'editor.pid');
    const listingPidPath = join(cli().home, 'listing.pid');

    let editorPid: number | undefined;

    await mkdir(commandDirectory);

    await writeFile(
      join(commandDirectory, 'ps'),
      `#!/bin/sh\nprintf '%s' $$ > '${listingPidPath}'\n${script}\n`,
      { mode: 0o755 },
    );

    const editorPath = await writeEditor(`#!/bin/sh
printf '%s' $$ > '${pidPath}'
trap '' TERM
exec /bin/sleep 30
`);

    const signalFailure =
      name === 'SIGTERM is refused'
        ? `
const signalProcess = process.kill.bind(process);
process.kill = (pid, signal) => {
  const editorPid = Number(readFileSync(${JSON.stringify(pidPath)}, 'utf8'));

  if (pid !== editorPid) {
    throw new Error('Refusing to signal a process outside this fixture.');
  }

  if (signal === 'SIGTERM') {
    refusedSignals += 1;

    throw Object.assign(new Error('Fixture signal denied.'), { code: 'EPERM' });
  }

  return signalProcess(pid, signal);
};
`
        : '';

    const runner = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
import { readFileSync } from 'node:fs';
import { createEffects } from ${JSON.stringify(entryPath)};
let refusedSignals = 0;
${signalFailure}
const cancellation = new AbortController();
process.on('SIGTERM', () => cancellation.abort());
const effects = createEffects(${JSON.stringify(cli().storePath)}, ${JSON.stringify(join(cli().home, 'cache.db'))});
const result = await effects.runEditor(${JSON.stringify(join(cli().home, 'unused.md'))}, cancellation.signal);
console.log(JSON.stringify({ ...result, refusedSignals }));
`,
      ],
      {
        env: { ...Bun.env, PATH: commandDirectory, EDITOR: editorPath },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    try {
      await waitFor(() => existsSync(pidPath), 'the editor PID file');

      editorPid = Number(await readFile(pidPath, 'utf8'));

      const stopping = Date.now();

      runner.kill('SIGTERM');
      await waitFor(() => runner.exitCode !== null, 'bounded editor cleanup');

      const result = (await runner.stdout.json()) as {
        ok: boolean;
        reason: { kind: string; message: string };
        refusedSignals: number;
      };

      expect(await runner.exited).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.reason.kind).toBe('cleanup');
      expect(typeof result.reason.message).toBe('string');
      expect(Date.now() - stopping).toBeLessThan(6000);
      expect(isRunning(editorPid)).toBe(false);

      if (name === 'SIGTERM is refused') {
        expect(result.refusedSignals).toBe(1);
      }
    } finally {
      runner.kill('SIGKILL');
      await runner.exited;

      if (editorPid !== undefined && isRunning(editorPid)) {
        process.kill(editorPid, 'SIGKILL');
      }

      if (existsSync(listingPidPath)) {
        const listingPid = Number(await readFile(listingPidPath, 'utf8'));

        if (isRunning(listingPid)) {
          process.kill(listingPid, 'SIGKILL');
        }
      }
    }
  },
  30_000,
);

it('returns a cleanup failure before an editor with refused TERM and KILL exits', async () => {
  const pidPath = join(cli().home, 'editor.pid');
  const resultPath = join(cli().home, 'result.json');
  const editorPath = await writeEditor(stuckEditor(pidPath));
  const preload = await writeSignalRefusal(pidPath);

  const program = `
import { createEffects } from ${JSON.stringify(entryPath)};
const cancellation = new AbortController();
process.on('SIGTERM', () => cancellation.abort());
const effects = createEffects(${JSON.stringify(cli().storePath)}, ${JSON.stringify(join(cli().home, 'cache.db'))});
const result = await effects.runEditor('unused.md', cancellation.signal);
await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify(result));
`;

  const runner = Bun.spawn([process.execPath, '--preload', preload, '--eval', program], {
    env: { ...Bun.env, EDITOR: editorPath },
    stdout: 'ignore',
    stderr: 'pipe',
  });

  let editorPid: number | undefined;

  try {
    await waitFor(() => existsSync(pidPath), 'the editor PID file');

    editorPid = Number(await readFile(pidPath, 'utf8'));

    const stopping = Date.now();

    runner.kill('SIGTERM');
    await waitFor(() => existsSync(resultPath), 'the cleanup failure before editor exit');

    const result = (await Bun.file(resultPath).json()) as {
      ok: boolean;
      reason: { kind: string; message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.reason.kind).toBe('cleanup');
    expect(result.reason.message.length).toBeGreaterThan(0);
    expect(Date.now() - stopping).toBeLessThan(6000);
    expect(isRunning(editorPid)).toBe(true);

    process.kill(editorPid, 'SIGKILL');

    expect(await runner.exited).toBe(0);
    expect(await runner.stderr.text()).toBe('');
    expect(isRunning(editorPid)).toBe(false);
  } finally {
    if (editorPid !== undefined && isRunning(editorPid)) {
      process.kill(editorPid, 'SIGKILL');
    }

    runner.kill('SIGKILL');
    await runner.exited;
  }
}, 30_000);

it.each(['process list failure', 'signal refusal'])(
  'restores the terminal before reporting %s and exiting 1',
  async (failure) => {
    await cli().runJson(['new', 'plan', 'aaaa', '--status', 'draft']);

    const commandDirectory = join(cli().home, 'commands');
    const pidPath = join(cli().home, 'editor.pid');

    await mkdir(commandDirectory);

    const listing = failure === 'process list failure' ? 'exit 1' : 'exec /bin/ps "$@"';

    await writeFile(join(commandDirectory, 'ps'), `#!/bin/sh\n${listing}\n`, { mode: 0o755 });

    const preload = failure === 'signal refusal' ? await writeSignalRefusal(pidPath) : undefined;

    const editorScript =
      failure === 'signal refusal'
        ? stuckEditor(pidPath).replace("trap '' TERM", "trap '' TERM HUP")
        : stuckEditor(pidPath);

    const tikk = startTikk(
      await writeEditor(editorScript),
      {
        PATH: `${commandDirectory}:${Bun.env.PATH ?? ''}`,
      },
      preload,
    );

    let editorPid: number | undefined;

    try {
      await tikk.waitForScreen('Nothing needs you.');

      tikk.type('s');
      await tikk.waitForScreen('aaaa  draft');

      const beforeEdit = tikk.terminal.output.length;

      tikk.type('e');
      await tikk.waitForOutput(editorReady, beforeEdit);

      editorPid = Number(await readFile(pidPath, 'utf8'));

      const stopping = Date.now();

      tikk.child.kill('SIGTERM');
      await waitFor(() => tikk.child.exitCode !== null, 'bounded terminal shutdown');

      expect(Date.now() - stopping).toBeLessThan(6000);
      expect(await tikk.child.exited).toBe(1);

      if (failure === 'signal refusal') {
        expect(isRunning(editorPid)).toBe(true);
      } else {
        expect(isRunning(editorPid)).toBe(false);
      }

      expect(screenOf(tikk.terminal.output).alternate).toBe(false);

      const restored = tikk.terminal.output.lastIndexOf(showCursor);
      const diagnostic = tikk.terminal.output.slice(restored + showCursor.length).trim();

      expect(restored).toBeGreaterThan(beforeEdit);
      expect(diagnostic.length).toBeGreaterThan(0);
    } finally {
      if (editorPid !== undefined && isRunning(editorPid)) {
        process.kill(editorPid, 'SIGKILL');
      }

      tikk.close();
    }
  },
  30_000,
);

it('keeps handling delayed SIGTERM during editor cleanup and restores the terminal', async () => {
  await cli().runJson(['new', 'plan', 'aaaa', '--status', 'draft']);

  const pidPath = join(cli().home, 'editor.pid');
  const editorScript = stuckEditor(pidPath).replace("trap '' TERM", "trap '' TERM HUP");
  const tikk = startTikk(await writeEditor(editorScript));
  let editorPid: number | undefined;

  try {
    await tikk.waitForScreen('Nothing needs you.');

    tikk.type('s');
    await tikk.waitForScreen('aaaa  draft');

    const beforeEdit = tikk.terminal.output.length;

    tikk.type('e');
    await tikk.waitForOutput(editorReady, beforeEdit);

    editorPid = Number(await readFile(pidPath, 'utf8'));

    const stopping = Date.now();

    tikk.child.kill('SIGTERM');
    await Bun.sleep(250);

    expect(tikk.child.exitCode).toBeNull();
    expect(tikk.child.signalCode).toBeNull();
    expect(isRunning(editorPid)).toBe(true);

    tikk.child.kill('SIGTERM');

    await waitFor(
      () => tikk.child.exitCode !== null || tikk.child.signalCode !== null,
      'bounded repeated-signal shutdown',
    );

    expect(Date.now() - stopping).toBeLessThan(6000);
    expect(await tikk.child.exited).toBe(0);
    expect(isRunning(editorPid)).toBe(false);
    expect(screenOf(tikk.terminal.output).alternate).toBe(false);
    expect(tikk.terminal.output.endsWith(showCursor)).toBe(true);
  } finally {
    if (editorPid !== undefined && isRunning(editorPid)) {
      process.kill(editorPid, 'SIGKILL');
    }

    tikk.close();
    await tikk.child.exited;
  }
}, 30_000);

it('stops an editor that ignores SIGTERM at shutdown, restores the terminal, and exits', async () => {
  await cli().runJson(['new', 'plan', 'aaaa', '--status', 'draft']);

  const pidPath = join(cli().home, 'editor.pid');
  const tikk = startTikk(await writeEditor(stuckEditor(pidPath)));

  try {
    await tikk.waitForScreen('Nothing needs you.');

    tikk.type('s');
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
