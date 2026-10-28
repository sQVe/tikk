import { afterEach, beforeEach, expect, it } from 'bun:test';
import { join } from 'node:path';

import { openNeedsSession } from '../src/cli/needsSession.ts';
import { createEffects } from '../src/index.ts';
import { invariant } from '../src/invariant.ts';
import { createCliFixture } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';

interface Shown {
  state: string;
  path: string;
}

interface TreeSliceRow {
  id: string;
  state: string;
  instructions: { id: string }[];
}

let fixture: CliFixture | undefined;

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const showJson = (id: string): Promise<Shown> => cli().runJson<Shown>(['show', id]);

// A planned slice whose one instruction is accepted, which makes the slice active.
const createSliceWithAcceptedInstruction = async (): Promise<{ slice: string; child: string }> => {
  const criteria = join(cli().home, 'criteria.yaml');

  await Bun.write(criteria, '- id: works\n  check: Run it\n  expected: It works\n');

  const slice = await cli().runJson<{ id: string }>([
    'new',
    'slice',
    'A slice',
    '--criteria-file',
    criteria,
  ]);

  const child = await cli().runJson<{ id: string }>([
    'new',
    'instruction',
    'An instruction',
    '--parent',
    slice.id,
  ]);

  await cli().runJson(['claim', child.id, '--holder', 'agent']);
  await cli().runJson(['submit', child.id, '--holder', 'agent']);
  await cli().runJson(['accept', child.id]);

  return { slice: slice.id, child: child.id };
};

beforeEach(async () => {
  fixture = await createCliFixture('tikk-broken-child-');
  await cli().runChecked(['init']);
});

afterEach(async () => {
  await fixture?.cleanup();
});

it('keeps a slice planned when its accepted child no longer parses', async () => {
  const { slice, child } = await createSliceWithAcceptedInstruction();

  expect((await showJson(slice)).state).toBe('active');

  const childPath = (await showJson(child)).path;

  await Bun.write(childPath, '---\ntitle: [unclosed\n---\n');

  expect((await showJson(slice)).state).toBe('planned');
});

const treeSliceOf = async (id: string): Promise<TreeSliceRow | undefined> => {
  const effects = createEffects(cli().storePath, join(cli().home, '.cache', 'tikk', 'index.db'));
  const opened = await openNeedsSession(effects);

  invariant(opened.ok, 'The real session should open.');

  const loaded = await opened.value.loadTree();

  await opened.value.close();

  invariant(loaded.ok, 'The real tree should load.');

  const projectSlices = loaded.value.projects.flatMap((project) => project.slices);

  const planSlices = loaded.value.projects
    .flatMap((project) => project.plans)
    .flatMap((plan) => plan.slices);

  return [...projectSlices, ...planSlices].find((slice) => slice.id === id);
};

it('shows a slice planned in the tree, as show does, and keeps the broken child row', async () => {
  const { slice, child } = await createSliceWithAcceptedInstruction();

  const childPath = (await showJson(child)).path;

  await Bun.write(childPath, '---\ntitle: [unclosed\n---\n');

  const row = await treeSliceOf(slice);

  expect(row?.state).toBe((await showJson(slice)).state);
  expect(row?.state).toBe('planned');
  expect(row?.instructions.map((instruction) => instruction.id)).toEqual([child]);
});
