import { afterEach, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configPathOf, readSettings } from '../src/config.ts';
import { resolveMachine, resolveProject } from '../src/project.ts';
import { loadBindings } from '../src/remap.ts';
import { commandLabel, createTuiFixture, needView } from '../src/tui/tuiHarness.tsx';
import type { TuiFixture } from '../src/tui/tuiHarness.tsx';

const homes: string[] = [];
let fixture: TuiFixture | undefined;

const homeWithConfig = async (config: unknown): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), 'tikk-home-'));

  homes.push(home);
  await mkdir(join(home, '.config', 'tikk'), { recursive: true });
  await writeFile(join(home, '.config', 'tikk', 'config.json'), JSON.stringify(config));

  return home;
};

afterEach(async () => {
  fixture?.cleanup();
  fixture = undefined;

  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const sharedConfig = { machine: 'laptop', projects: { 'sqve/tikk': 'tk' }, keys: { help: ['h'] } };

it('applies the key remap in the TUI and resolves the machine and project from the same file', async () => {
  const home = await homeWithConfig(sharedConfig);
  const loaded = loadBindings(readSettings(home), configPathOf(home));

  expect(loaded.messages).toEqual([]);

  fixture = await createTuiFixture(
    [needView(0, 'First')],
    { width: 80, height: 40 },
    [],
    [],
    {},
    loaded.bindings,
  );

  await fixture.press('h');

  expect(fixture.setup.captureCharFrame()).toContain(commandLabel('closeHelp'));

  const machine = resolveMachine({
    runGit: async () => ({ kind: 'failed' }),
    readSettings: () => readSettings(home),
    hostName: 'Build-Host',
  });

  expect(machine).toEqual({ ok: true, value: 'laptop' });

  const project = await resolveProject('/work/repo', {
    runGit: async () => ({ kind: 'output', stdout: 'git@github.com:sQVe/tikk.git' }),
    readSettings: () => readSettings(home),
    hostName: 'Build-Host',
  });

  expect(project).toMatchObject({ ok: true, value: 'tk' });
});
