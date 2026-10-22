import { expect, it } from 'bun:test';

import { failureOf, makeTicket, successOf } from './cliHarness.ts';
import {
  claimBy,
  submittedBy,
  accepted,
  run,
  noSideEffects,
  sideEffectsOf,
  orphan,
} from './taskHarness.ts';
import { taskLog } from './taskLog.ts';

it('logs to a done task without changing its state', async () => {
  const { fakeSession, result } = await run(
    taskLog,
    ['demo-3467', '--type', 'discovered', '--text', 'A finding', '--holder', 'agent'],
    { facts: [claimBy('agent'), submittedBy('agent'), accepted] },
  );

  expect(successOf(result).json).toMatchObject({ state: 'done' });

  expect(fakeSession.appends.map(({ fact }) => fact)).toMatchObject([
    { kind: 'log', type: 'discovered', text: 'A finding', holder: 'agent' },
  ]);
});

it('refuses a log with a type it does not accept and writes nothing', async () => {
  for (const type of ['submitted', 'note']) {
    const { fakeSession, result } = await run(taskLog, [
      'demo-3467',
      '--type',
      type,
      '--text',
      'A note',
    ]);

    expect(failureOf(result).code).toBe('invalidArguments');
    expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
  }
});

it('refuses a log without text and writes nothing', async () => {
  const { fakeSession, result } = await run(taskLog, ['demo-3467', '--type', 'progress']);

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('logs to a task whose file has an error', async () => {
  const broken = makeTicket('demo-3467', { error: 'Bad YAML.' });

  const { fakeSession, result } = await run(
    taskLog,
    ['demo-3467', '--type', 'progress', '--text', 'A note'],
    {
      tickets: [broken],
    },
  );

  successOf(result);
  expect(fakeSession.appends).toHaveLength(1);
});

it('reports a fact the store refuses as invalid arguments', async () => {
  const { result } = await run(taskLog, ['demo-3467', '--type', 'progress', '--text', 'A note'], {
    session: {
      overrides: {
        appendFact: () =>
          Promise.resolve({
            ok: false,
            reason: { kind: 'invalid', message: 'holder: Too small.' },
          }),
      },
    },
  });

  expect(failureOf(result)).toEqual({ code: 'invalidArguments', message: 'holder: Too small.' });
});

it('still appends a log to a task whose parent does not exist', async () => {
  const { fakeSession, result } = await run(
    taskLog,
    ['demo-3467', '--type', 'progress', '--text', 'Working on it'],
    { tickets: [orphan()] },
  );

  successOf(result);
  expect(fakeSession.appends).toHaveLength(1);
});
