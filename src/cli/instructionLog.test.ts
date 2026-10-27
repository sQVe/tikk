import { expect, it } from 'bun:test';

import { failureOf, makeFact, makeTicket, successOf } from './cliHarness.ts';
import {
  claimBy,
  submittedBy,
  accepted,
  run,
  noSideEffects,
  sideEffectsOf,
  orphan,
  itemOf,
} from './instructionHarness.ts';
import { instructionLog } from './instructionLog.ts';

it('logs to a done instruction without changing its state', async () => {
  const { fakeSession, result } = await run(
    instructionLog,
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
    const { fakeSession, result } = await run(instructionLog, [
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
  const { fakeSession, result } = await run(instructionLog, ['demo-3467', '--type', 'progress']);

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('logs to an instruction whose file has an error', async () => {
  const broken = makeTicket('demo-3467', { error: 'Bad YAML.' });

  const { fakeSession, result } = await run(
    instructionLog,
    ['demo-3467', '--type', 'progress', '--text', 'A note'],
    {
      tickets: [broken],
    },
  );

  successOf(result);
  expect(fakeSession.appends).toHaveLength(1);
});

it('reports a fact the store refuses as invalid arguments', async () => {
  const { result } = await run(
    instructionLog,
    ['demo-3467', '--type', 'progress', '--text', 'A note'],
    {
      session: {
        overrides: {
          appendFact: () =>
            Promise.resolve({
              ok: false,
              reason: { kind: 'invalid', message: 'holder: Too small.' },
            }),
        },
      },
    },
  );

  expect(failureOf(result)).toEqual({ code: 'invalidArguments', message: 'holder: Too small.' });
});

it('still appends a log to an instruction whose parent does not exist', async () => {
  const { fakeSession, result } = await run(
    instructionLog,
    ['demo-3467', '--type', 'progress', '--text', 'Working on it'],
    { tickets: [orphan()] },
  );

  successOf(result);
  expect(fakeSession.appends).toHaveLength(1);
});

const question = makeFact({ kind: 'log', type: 'question', text: 'Why?', item: '0000000000a1' });

it('gives a question a new item and prints it', async () => {
  const { fakeSession, result } = await run(instructionLog, [
    'demo-3467',
    '--type',
    'question',
    '--text',
    'Which one?',
  ]);

  const item = itemOf(result);

  expect(item).toMatch(/^[0-9a-f]{12}$/);
  expect(fakeSession.appends.map(({ fact }) => fact)).toMatchObject([{ type: 'question', item }]);
});

it('records an answer to an open question with its item', async () => {
  const { fakeSession, result } = await run(
    instructionLog,
    ['demo-3467', '--type', 'answer', '--text', 'That one', '--item', '0000000000a1'],
    { facts: [question] },
  );

  successOf(result);

  expect(fakeSession.appends.map(({ fact }) => fact)).toMatchObject([
    { type: 'answer', item: '0000000000a1' },
  ]);
});

it('refuses an answer without an item and writes nothing', async () => {
  const { fakeSession, result } = await run(
    instructionLog,
    ['demo-3467', '--type', 'answer', '--text', 'That one'],
    { facts: [question] },
  );

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('refuses an answer to an unknown or answered item and writes nothing', async () => {
  const answered = makeFact({ kind: 'log', type: 'answer', text: 'So.', item: '0000000000a1' });

  const cases = [
    { item: '0000000000c1', facts: [question] },
    { item: '0000000000a1', facts: [question, answered] },
  ];

  for (const { item, facts } of cases) {
    const { fakeSession, result } = await run(
      instructionLog,
      ['demo-3467', '--type', 'answer', '--text', 'That one', '--item', item],
      { facts },
    );

    expect(failureOf(result).code).toBe('conflict');
    expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
  }
});

it('refuses an item on a log that is not an answer and writes nothing', async () => {
  const { fakeSession, result } = await run(instructionLog, [
    'demo-3467',
    '--type',
    'progress',
    '--text',
    'A note',
    '--item',
    '0000000000a1',
  ]);

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});
