import { afterEach, beforeEach, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';

import { invariant } from '../src/invariant.ts';
import { createCliFixture, createParentSlice } from './cliFixture.ts';
import type { CliFixture, CliRun } from './cliFixture.ts';

interface ShownTicket {
  id: string;
  path: string;
  hash: string;
  blockedBy: string[];
}

let fixture: CliFixture | undefined;

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const createTask = (title: string, args: string[] = []): Promise<ShownTicket> =>
  cli().runJson<ShownTicket>(['new', 'task', title, ...args]);

const show = (id: string): Promise<ShownTicket> => cli().runJson<ShownTicket>(['show', id]);

const errorMessageOf = (result: CliRun): string => {
  const parsed = JSON.parse(result.stdout) as { error: { message: string } };

  return parsed.error.message;
};

beforeEach(async () => {
  fixture = await createCliFixture('tikk-blockers-');
  await fixture.runChecked(['init']);
});

afterEach(async () => {
  await fixture?.cleanup();
});

it('refuses to block a ticket by one it blocks and leaves the file unchanged', async () => {
  const first = await createTask('First');
  const second = await createTask('Second', ['--blocked-by', first.id]);
  const before = await readFile(second.path);

  const result = await cli().run(['block', first.id, second.id]);
  const message = errorMessageOf(result);

  expect(result.exitCode).not.toBe(0);
  expect(message).toContain(first.id);
  expect(message).toContain(second.id);
  expect(await readFile(second.path)).toEqual(before);
  expect((await show(first.id)).blockedBy).toEqual([]);
});

it('refuses to block a slice by an instruction under it and names the cycle', async () => {
  const slice = await createParentSlice(cli());

  const instruction = await cli().runJson<ShownTicket>([
    'new',
    'instruction',
    'Under the slice',
    '--parent',
    slice,
  ]);

  const result = await cli().run(['block', slice, instruction.id]);

  expect(result.exitCode).not.toBe(0);
  expect(errorMessageOf(result)).toContain(`${slice}, ${instruction.id}, ${slice}`);
  expect((await show(slice)).blockedBy).toEqual([]);
});

it('adds and removes a blocker, and writes nothing when either repeats', async () => {
  const blocked = await createTask('Blocked');
  const blocker = await createTask('Blocker');

  await cli().runChecked(['block', blocked.id, blocker.id]);
  const afterBlock = await show(blocked.id);
  const blockedFile = await readFile(blocked.path);

  await cli().runChecked(['block', blocked.id, blocker.id]);
  const afterRepeatedBlock = await show(blocked.id);

  expect(afterBlock.blockedBy).toEqual([blocker.id]);
  expect(afterRepeatedBlock.hash).toBe(afterBlock.hash);
  expect(await readFile(blocked.path)).toEqual(blockedFile);

  await cli().runChecked(['unblock', blocked.id, blocker.id]);
  const afterUnblock = await show(blocked.id);
  const unblockedFile = await readFile(blocked.path);

  await cli().runChecked(['unblock', blocked.id, blocker.id]);
  const afterRepeatedUnblock = await show(blocked.id);

  expect(afterUnblock.blockedBy).toEqual([]);
  expect(afterRepeatedUnblock.hash).toBe(afterUnblock.hash);
  expect(await readFile(blocked.path)).toEqual(unblockedFile);
});

it('refuses an unknown blocker and the ticket itself, and writes nothing', async () => {
  const task = await createTask('Alone');
  const before = await readFile(task.path);
  const project = task.id.slice(0, task.id.lastIndexOf('-'));
  const unknownSuffix = task.id.endsWith('-3467') ? '3468' : '3467';
  const unknownId = `${project}-${unknownSuffix}`;

  const unknown = await cli().run(['block', task.id, unknownId]);
  const itself = await cli().run(['block', task.id, task.id]);

  expect(unknown.exitCode).not.toBe(0);
  expect(errorMessageOf(unknown)).toContain(unknownId);
  expect(itself.exitCode).not.toBe(0);
  expect(errorMessageOf(itself)).toContain(task.id);
  expect(await readFile(task.path)).toEqual(before);
});
