import { afterEach, beforeEach, expect, it } from 'bun:test';
import { join } from 'node:path';

import { openNeedsSession } from '../src/cli/needsSession.ts';
import { createEffects } from '../src/index.ts';
import { invariant } from '../src/invariant.ts';
import { createCliFixture } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';

interface TreeSliceRow {
  id: string;
  state: string;
}

let fixture: CliFixture | undefined;

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const showJson = (id: string): Promise<{ state: string }> => cli().runJson(['show', id]);

const treeSliceOf = async (id: string): Promise<TreeSliceRow | undefined> => {
  const effects = createEffects(cli().storePath, join(cli().home, '.cache', 'tikk', 'index.db'));
  const opened = await openNeedsSession(effects);

  invariant(opened.ok, 'The real session should open.');

  const loaded = await opened.value.loadTree();

  await opened.value.close();

  invariant(loaded.ok, 'The real tree should load.');

  const projectSlices = loaded.value.projects.flatMap((project) => project.slices);

  return projectSlices.find((slice) => slice.id === id);
};

beforeEach(async () => {
  fixture = await createCliFixture('tikk-draft-slice-');
  await cli().runChecked(['init']);
});

afterEach(async () => {
  await fixture?.cleanup();
});

it('shows a draft slice as draft in the tree and in show --json', async () => {
  const slice = await cli().runJson<{ id: string }>([
    'new',
    'slice',
    'A draft slice',
    '--status',
    'draft',
  ]);

  const row = await treeSliceOf(slice.id);

  expect(row?.state).toBe('draft');
  expect((await showJson(slice.id)).state).toBe('draft');
});
