import { afterEach, expect, it } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { act } from 'react';

import { openNeedsSession } from '../src/cli/cli.ts';
import { createEffects } from '../src/index.ts';
import { createTuiFixture } from '../src/tui/tuiHarness.tsx';
import type { TuiFixture } from '../src/tui/tuiHarness.tsx';
import { createCliFixture, createParentSlice } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';

let cli: CliFixture | undefined;
let tui: TuiFixture | undefined;

afterEach(async () => {
  tui?.cleanup();
  tui = undefined;
  await cli?.cleanup();
  cli = undefined;
});

const settle = async (fixture: TuiFixture, text: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await act(async () => {
      await Bun.sleep(20);
      await fixture.setup.renderOnce();
    });

    if (fixture.setup.captureCharFrame().includes(text)) {
      return;
    }
  }
};

it('shows the path and parse error of a ticket file that was broken on disk', async () => {
  cli = await createCliFixture('tikk-tui-file-error-');
  await cli.runChecked(['init']);

  const parent = await createParentSlice(cli);

  const created = await cli.runJson<{ id: string; path: string }>([
    'new',
    'instruction',
    'First',
    '--parent',
    parent,
  ]);

  await writeFile(created.path, '---\nkind: [\n---\n');

  const opened = await openNeedsSession(createEffects(cli.storePath, join(cli.home, 'index.db')));

  expect(opened.ok).toBe(true);

  if (!opened.ok) {
    return;
  }

  const needs = opened.value;

  try {
    tui = await createTuiFixture([], { width: 160, height: 20 }, [], [], {
      load: needs.load,
      loadTree: needs.loadTree,
      loadErrors: needs.loadErrors,
    });

    await settle(tui, '1 file error');
    await tui.press('g');
    await tui.press('m');

    const frame = tui.setup.captureCharFrame();

    expect(frame).toContain(created.path);
    expect(frame).toContain('YAML Parse error');
  } finally {
    await needs.close();
  }
});
