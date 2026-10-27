import { afterEach, beforeEach, expect, it } from 'bun:test';

import { invariant } from '../src/invariant.ts';
import { createCliFixture, createParentSlice } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';

interface NeedsItem {
  id: string;
  reason: string;
  blocks?: string[];
  text?: string;
}

interface NeedsListing {
  items: NeedsItem[];
}

let fixture: CliFixture | undefined;
let parentSlice = '';

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const reasonsOf = async (id: string): Promise<string[]> => {
  const listing = await cli().runJson<NeedsListing>(['needs']);

  return listing.items.filter((item) => item.id === id).map((item) => item.reason);
};

const createInstruction = async (title: string, extra: string[] = []): Promise<string> => {
  const created = await cli().runJson<{ id: string }>([
    'new',
    'instruction',
    title,
    '--parent',
    parentSlice,
    ...extra,
  ]);

  return created.id;
};

beforeEach(async () => {
  fixture = await createCliFixture('tikk-needs-');
  await cli().runChecked(['init']);
  parentSlice = await createParentSlice(cli());
});

afterEach(async () => {
  await fixture?.cleanup();
});

it('lists a passed-up question until an answer to it is logged', async () => {
  const id = await createInstruction('Asked instruction');

  const { item } = await cli().runJson<{ item: string }>([
    'log',
    id,
    '--type',
    'question',
    '--text',
    'Which one?',
  ]);

  expect(await reasonsOf(id)).toEqual([]);

  await cli().runJson(['pass-up', id, '--item', item]);

  expect(await reasonsOf(id)).toEqual(['question']);

  await cli().runJson(['log', id, '--type', 'answer', '--text', 'This one', '--item', item]);

  expect(await reasonsOf(id)).toEqual([]);
});

it('lists a passed-up submission until it is accepted', async () => {
  const id = await createInstruction('Submitted instruction');

  await cli().runJson(['claim', id, '--holder', 'agent']);

  const { item } = await cli().runJson<{ item: string }>(['submit', id, '--holder', 'agent']);

  await cli().runJson(['pass-up', id, '--item', item]);

  expect(await reasonsOf(id)).toEqual(['submitted']);

  await cli().runJson(['accept', id]);

  expect(await reasonsOf(id)).toEqual([]);
});

const needOf = async (id: string): Promise<NeedsItem | undefined> => {
  const listing = await cli().runJson<NeedsListing>(['needs']);

  return listing.items.find((item) => item.id === id);
};

it('lists an open task that blocks two instructions once, until it is done', async () => {
  const blocker = await cli().runJson<{ id: string }>(['new', 'task', 'Blocking task']);
  const first = await createInstruction('First instruction', ['--blocked-by', blocker.id]);
  const second = await createInstruction('Second instruction', ['--blocked-by', blocker.id]);

  expect(await needOf(blocker.id)).toMatchObject({
    reason: 'blockingTask',
    blocks: [first, second].toSorted(),
  });

  await cli().runChecked(['done', blocker.id]);

  expect(await needOf(blocker.id)).toBeUndefined();
});

it('lists a draft plan only while its latest waiting fact is true', async () => {
  const plan = await cli().runJson<{ id: string }>([
    'new',
    'plan',
    'Draft plan',
    '--status',
    'draft',
  ]);

  expect(await needOf(plan.id)).toBeUndefined();

  await cli().runChecked(['wait', plan.id, '--text', 'Pick a name']);

  expect(await needOf(plan.id)).toMatchObject({ reason: 'draftPlan', text: 'Pick a name' });

  await cli().runChecked(['wait', plan.id, '--done']);

  expect(await needOf(plan.id)).toBeUndefined();
});

it('lists a loose new task until a move puts it under a slice', async () => {
  const task = await cli().runJson<{ id: string }>(['new', 'task', 'Loose task']);

  expect(await reasonsOf(task.id)).toEqual(['newTask']);

  await cli().runChecked(['move', task.id, '--parent', parentSlice]);

  expect(await reasonsOf(task.id)).toEqual([]);
});

it('does not list an open task that only an accepted instruction blocks', async () => {
  const task = await cli().runJson<{ id: string }>([
    'new',
    'task',
    'Blocking task',
    '--parent',
    parentSlice,
  ]);

  const instruction = await createInstruction('Accepted instruction', ['--blocked-by', task.id]);

  await cli().runJson(['claim', instruction, '--holder', 'agent']);
  await cli().runJson(['submit', instruction, '--holder', 'agent']);

  expect(await needOf(task.id)).toMatchObject({ reason: 'blockingTask' });

  await cli().runJson(['accept', instruction]);

  expect(await needOf(task.id)).toBeUndefined();
});
