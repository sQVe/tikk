import { expect, it } from 'bun:test';

import { checkCommand } from './checkCommand.ts';
import { failureOf, makeEffects, makeSession, makeTicket } from './cliHarness.ts';

const run = async (args: string[], files: Record<string, string> = {}) => {
  const fakeSession = makeSession({ tickets: [makeTicket('demo-3467')] });
  const { effects } = makeEffects({ session: fakeSession, files });
  const result = await checkCommand({ args, json: true, effects, session: fakeSession.session });

  return { result, fakeSession };
};

const addFlags = [
  '--command',
  'bun test',
  '--exit-code',
  '0',
  '--repository',
  'tikk',
  '--head',
  'aaa',
  '--base',
  'main',
  '--change-hash',
  'hash1',
];

it('refuses an unknown subcommand', async () => {
  const { result } = await run(['nope']);

  expect(failureOf(result).code).toBe('invalidArguments');
});

it('refuses add without a required flag', async () => {
  const withoutHead = addFlags.filter((_, index) => index !== 8 && index !== 9);
  const { result, fakeSession } = await run(['add', 'demo-3467', ...withoutHead]);

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.appends).toEqual([]);
});

it('refuses an exit code that is not an integer of 0 or more', async () => {
  for (const code of ['-1', '1.5', 'x']) {
    const flags = addFlags.map((flag, index) => (index === 3 ? code : flag));
    const { result, fakeSession } = await run(['add', 'demo-3467', ...flags]);

    expect(failureOf(result).code).toBe('invalidArguments');
    expect(fakeSession.appends).toEqual([]);
  }
});

it('refuses add with a log file that cannot be read', async () => {
  const { result, fakeSession } = await run([
    'add',
    'demo-3467',
    ...addFlags,
    '--log-file',
    '/missing.log',
  ]);

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.appends).toEqual([]);
});

it('refuses ls without --head', async () => {
  const { result } = await run(['ls', 'demo-3467']);

  expect(failureOf(result).code).toBe('invalidArguments');
});

it('refuses add for a ticket that does not exist', async () => {
  const { result } = await run(['add', 'demo-9999', ...addFlags]);

  expect(failureOf(result).code).toBe('notFound');
});
