import { afterEach, beforeEach, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { createCliFixture } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';
import { startTerminalTikk, waitFor, writeEditorScript } from './tuiTerminalFixture.ts';

let fixture: CliFixture | undefined;

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const recordingEditor = (recordPath: string): string =>
  `#!/bin/sh\nprintf '%s' "$1" > '${recordPath}'\n`;

const designPathOf = (projectName: string, id: string): string =>
  join(cli().storePath, 'tickets', projectName, id, 'design.md');

beforeEach(async () => {
  fixture = await createCliFixture('tikk-tui-design-editor-');
  await cli().runChecked(['init']);
});

afterEach(async () => {
  await fixture?.cleanup();
});

it('opens the design.md of the selected plan in $EDITOR on D', async () => {
  const plan = await cli().runJson<{ id: string; project: string }>([
    'new',
    'plan',
    'aaaa',
    '--status',
    'draft',
  ]);

  const folder = join(cli().storePath, 'tickets', plan.project, plan.id);
  const recordPath = join(cli().home, 'editor-argument.txt');

  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'design.md'), '# Design\n');

  const editorPath = await writeEditorScript(cli().home, recordingEditor(recordPath));
  const tikk = startTerminalTikk(cli(), editorPath);

  try {
    await tikk.waitForScreen('Nothing needs you.');

    await tikk.selectPlan(`${plan.id}  aaaa`);
    tikk.type('D');

    await waitFor(() => existsSync(recordPath), 'the design editor run');

    expect(await readFile(recordPath, 'utf8')).toBe(designPathOf(plan.project, plan.id));

    tikk.type('q');

    expect(await tikk.child.exited).toBe(0);
  } finally {
    tikk.close();
  }
}, 30_000);
