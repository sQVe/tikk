import { expect, it } from 'bun:test';

import { failureOf, makeEffects, makeSession, makeTicket } from './cliHarness.ts';
import { findingCommand } from './findingCommand.ts';

const run = async (args: string[]) => {
  const fakeSession = makeSession({ tickets: [makeTicket('demo-3467')] });
  const { effects } = makeEffects({ session: fakeSession });
  const result = await findingCommand({ args, json: true, effects, session: fakeSession.session });

  return { result, fakeSession };
};

const setFlags = ['--status', 'fixed', '--reason', 'Done', '--actor', 'agent'];

it('refuses an unknown subcommand', async () => {
  const { result } = await run(['nope']);

  expect(failureOf(result).code).toBe('invalidArguments');
});

it('refuses set without a fingerprint', async () => {
  const { result } = await run(['set', 'demo-3467', ...setFlags]);

  expect(failureOf(result).code).toBe('invalidArguments');
});

it('refuses set without a required flag', async () => {
  for (const drop of [0, 2, 4]) {
    const flags = setFlags.filter((_, index) => index !== drop && index !== drop + 1);
    const { result, fakeSession } = await run(['set', 'demo-3467', 'fp-1', ...flags]);

    expect(failureOf(result).code).toBe('invalidArguments');
    expect(fakeSession.appends).toEqual([]);
  }
});

it('refuses set with a status that is not valid', async () => {
  const { result } = await run([
    'set',
    'demo-3467',
    'fp-1',
    '--status',
    'done',
    ...setFlags.slice(2),
  ]);

  expect(failureOf(result).code).toBe('invalidArguments');
});

it('refuses set for a fingerprint no review holds', async () => {
  const { result, fakeSession } = await run(['set', 'demo-3467', 'fp-1', ...setFlags]);

  expect(failureOf(result).code).toBe('notFound');
  expect(fakeSession.appends).toEqual([]);
});

it('refuses ls with a status that is not valid', async () => {
  const { result } = await run(['ls', 'demo-3467', '--status', 'done']);

  expect(failureOf(result).code).toBe('invalidArguments');
});
