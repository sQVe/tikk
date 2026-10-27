import { afterEach, beforeEach, expect, it } from 'bun:test';

import { invariant } from '../src/invariant.ts';
import { createCliFixture, createParentSlice } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';

interface NeedsListing {
  items: { id: string; reason: string }[];
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

const createInstruction = async (title: string): Promise<string> => {
  const created = await cli().runJson<{ id: string }>([
    'new',
    'instruction',
    title,
    '--parent',
    parentSlice,
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
