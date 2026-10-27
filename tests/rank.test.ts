import { afterEach, beforeEach, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { parseTicketFile } from '../src/ticket/ticket.ts';
import { createCliFixture } from './cliFixture.ts';
import type { CliFixture, CliRun } from './cliFixture.ts';

interface ShownTicket {
  id: string;
  path: string;
  parent?: string;
}

interface ReadyListing {
  candidates: { id: string }[];
}

let fixture: CliFixture | undefined;

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const create = (args: string[]): Promise<ShownTicket> =>
  cli().runJson<ShownTicket>(['new', ...args]);

const errorMessageOf = (result: CliRun): string => {
  const parsed = JSON.parse(result.stdout) as { error: { message: string } };

  return parsed.error.message;
};

const createSlice = async (title: string, parent?: string): Promise<ShownTicket> => {
  const file = join(cli().home, `${title}-criteria.yaml`);

  await Bun.write(file, '- id: a\n  check: check a\n  expected: a holds\n');

  const args = ['slice', title, '--criteria-file', file];

  return create(parent === undefined ? args : [...args, '--parent', parent]);
};

const readyIds = async (args: string[]): Promise<string[]> => {
  const listing = await cli().runJson<ReadyListing>(['ready', ...args]);

  return listing.candidates.map((candidate) => candidate.id);
};

beforeEach(async () => {
  fixture = await createCliFixture('tikk-rank-');
  await fixture.runChecked(['init']);
});

afterEach(async () => {
  await fixture?.cleanup();
});

it('ranks a slice first among its siblings so ready lists it first', async () => {
  const plan = await create(['plan', 'Plan', '--status', 'draft']);
  await createSlice('First', plan.id);
  await createSlice('Second', plan.id);

  const [leading, trailing] = await readyIds(['--kind', 'slice']);

  invariant(leading !== undefined && trailing !== undefined, 'Two slices should be ready.');

  await cli().runChecked(['rank', trailing, '--first']);

  expect(await readyIds(['--kind', 'slice'])).toEqual([trailing, leading]);
});

it('places an instruction before or after a sibling in the ready order', async () => {
  const slice = await createSlice('Slice');

  await create(['instruction', 'One', '--parent', slice.id]);
  await create(['instruction', 'Two', '--parent', slice.id]);
  await create(['instruction', 'Three', '--parent', slice.id]);

  const [first, second, third] = await readyIds(['--parent', slice.id]);

  invariant(
    first !== undefined && second !== undefined && third !== undefined,
    'Three instructions should be ready.',
  );

  await cli().runChecked(['rank', third, '--before', first]);

  expect(await readyIds(['--parent', slice.id])).toEqual([third, first, second]);

  await cli().runChecked(['rank', third, '--after', second]);

  expect(await readyIds(['--parent', slice.id])).toEqual([first, second, third]);
});

it('refuses to rank before a ticket with another parent and writes nothing', async () => {
  const slice = await createSlice('Slice');
  const otherSlice = await createSlice('Other slice');
  const instruction = await create(['instruction', 'Mine', '--parent', slice.id]);
  const outsider = await create(['instruction', 'Outsider', '--parent', otherSlice.id]);
  const instructionBefore = await readFile(instruction.path);
  const outsiderBefore = await readFile(outsider.path);

  const result = await cli().run(['rank', instruction.id, '--before', outsider.id]);

  expect(result.exitCode).not.toBe(0);
  expect(errorMessageOf(result)).toContain(outsider.id);
  expect(await readFile(instruction.path)).toEqual(instructionBefore);
  expect(await readFile(outsider.path)).toEqual(outsiderBefore);
});

it('removes new from a loose task when it is ranked', async () => {
  const task = await create(['task', 'Loose task']);

  const before = parseTicketFile(await readFile(task.path, 'utf8'));

  expect(before.ok && before.value.frontMatter.new).toBe(true);

  await cli().runChecked(['rank', task.id, '--first']);

  const after = parseTicketFile(await readFile(task.path, 'utf8'));

  expect(after.ok && after.value.frontMatter.new).toBeUndefined();
});
