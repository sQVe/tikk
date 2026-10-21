import { afterEach, beforeEach, expect, it } from 'bun:test';

import { invariant } from '../src/invariant.ts';
import { createCliFixture } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';

interface NeedsListing {
  items: { id: string; reason: string }[];
}

let fixture: CliFixture | undefined;

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const reasonsOf = async (id: string): Promise<string[]> => {
  const listing = await cli().runJson<NeedsListing>(['needs']);

  return listing.items.filter((item) => item.id === id).map((item) => item.reason);
};

const createTask = async (title: string): Promise<string> => {
  const created = await cli().runJson<{ id: string }>(['new', 'task', title]);

  return created.id;
};

beforeEach(async () => {
  fixture = await createCliFixture('tikk-needs-');
  await cli().runChecked(['init']);
});

afterEach(async () => {
  await fixture?.cleanup();
});

it('lists a question until an answer is logged', async () => {
  const id = await createTask('Asked task');

  await cli().runJson(['log', id, '--type', 'question', '--text', 'Which one?']);

  expect(await reasonsOf(id)).toEqual(['question']);

  await cli().runJson(['log', id, '--type', 'answer', '--text', 'This one']);

  expect(await reasonsOf(id)).toEqual([]);
});

it('lists a submitted task until it is accepted', async () => {
  const id = await createTask('Submitted task');

  await cli().runJson(['claim', id, '--holder', 'agent']);
  await cli().runJson(['submit', id, '--holder', 'agent']);

  expect(await reasonsOf(id)).toEqual(['submitted']);

  await cli().runJson(['accept', id]);

  expect(await reasonsOf(id)).toEqual([]);
});
