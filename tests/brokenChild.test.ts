import { afterEach, beforeEach, expect, it } from 'bun:test';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { createCliFixture } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';

interface Shown {
  state: string;
  path: string;
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
