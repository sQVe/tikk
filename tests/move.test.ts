import { afterEach, beforeEach, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { parseTicketFile } from '../src/ticket/ticket.ts';
import { createCliFixture, createParentSlice } from './cliFixture.ts';
import type { CliFixture, CliRun } from './cliFixture.ts';

interface ShownTicket {
  id: string;
  path: string;
  parent?: string;
}

let fixture: CliFixture | undefined;

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const create = (args: string[]): Promise<ShownTicket> =>
  cli().runJson<ShownTicket>(['new', ...args]);

const show = (id: string): Promise<ShownTicket> => cli().runJson<ShownTicket>(['show', id]);

const errorMessageOf = (result: CliRun): string => {
  const parsed = JSON.parse(result.stdout) as { error: { message: string } };

  return parsed.error.message;
};

const createSliceWithCriterion = async (): Promise<string> => {
  const file = join(cli().home, 'criteria.yaml');

  await Bun.write(file, '- id: a\n  check: check a\n  expected: a holds\n');

  const slice = await create(['slice', 'Covered slice', '--criteria-file', file]);

  return slice.id;
};

beforeEach(async () => {
  fixture = await createCliFixture('tikk-move-');
  await fixture.runChecked(['init']);
});

afterEach(async () => {
  await fixture?.cleanup();
});

it('refuses to move an instruction under a plan and leaves the file unchanged', async () => {
  const slice = await createParentSlice(cli());
  const plan = await create(['plan', 'Plan', '--status', 'draft']);
  const instruction = await create(['instruction', 'Instruction', '--parent', slice]);
  const before = await readFile(instruction.path);

  const result = await cli().run(['move', instruction.id, '--parent', plan.id, '--json']);

  expect(result.exitCode).not.toBe(0);
  expect(await readFile(instruction.path)).toEqual(before);

  const otherSlice = await createParentSlice(cli());

  await cli().runChecked(['move', instruction.id, '--parent', otherSlice, '--json']);

  expect((await show(instruction.id)).parent).toBe(otherSlice);
});

it('moves a task from a slice to a plan', async () => {
  const slice = await createParentSlice(cli());
  const plan = await create(['plan', 'Plan', '--status', 'draft']);
  const task = await create(['task', 'Task', '--parent', slice]);

  await cli().runChecked(['move', task.id, '--parent', plan.id, '--json']);

  expect((await show(task.id)).parent).toBe(plan.id);
});

it('removes new from a loose task that moves under a slice', async () => {
  const slice = await createParentSlice(cli());
  const task = await create(['task', 'Loose task']);
  const before = parseTicketFile(await Bun.file(task.path).text());

  expect(before.ok && before.value.frontMatter.new).toBe(true);

  await cli().runChecked(['move', task.id, '--parent', slice, '--json']);

  const after = parseTicketFile(await Bun.file(task.path).text());

  expect(after.ok && after.value.frontMatter.new).toBeUndefined();
  expect((await show(task.id)).parent).toBe(slice);
});

it('refuses to move a task under a slice it blocks, names the cycle, and writes nothing', async () => {
  const task = await create(['task', 'Blocker']);
  const slice = await create(['slice', 'Blocked', '--status', 'draft', '--blocked-by', task.id]);
  const before = await readFile(task.path);

  const result = await cli().run(['move', task.id, '--parent', slice.id, '--json']);

  expect(result.exitCode).not.toBe(0);
  expect(errorMessageOf(result)).toContain(`${task.id}, ${slice.id}, ${task.id}`);
  expect(await readFile(task.path)).toEqual(before);
});

it('refuses to move an instruction whose covers the new slice lacks and writes nothing', async () => {
  const covered = await createSliceWithCriterion();
  const other = await createParentSlice(cli());

  const instruction = await create([
    'instruction',
    'Covering',
    '--parent',
    covered,
    '--covers',
    'a',
  ]);

  const before = await readFile(instruction.path);

  const result = await cli().run(['move', instruction.id, '--parent', other, '--json']);

  expect(result.exitCode).not.toBe(0);
  expect(errorMessageOf(result)).toContain(other);
  expect(await readFile(instruction.path)).toEqual(before);
});
