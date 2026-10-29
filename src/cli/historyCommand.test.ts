import { expect, it } from 'bun:test';

import type { Fact } from '../fact/fact.ts';
import {
  failed,
  failureOf,
  makeEffects,
  makeFact,
  makeSession,
  makeTicket,
  successOf,
} from './cliHarness.ts';
import { historyCommand } from './historyCommand.ts';

const question = makeFact({
  kind: 'log',
  type: 'question',
  text: 'Which store?',
  item: '0123456789ab',
  at: '2026-10-20T10:00:00.000Z',
});

const progress = makeFact({
  kind: 'log',
  type: 'progress',
  text: 'Wrote the parser',
  at: '2026-10-20T11:00:00.000Z',
});

const history = (args: string[], facts: Fact[] = [question, progress]) => {
  const { session } = makeSession({ tickets: [makeTicket('demo-3467')], facts });
  const { effects } = makeEffects();

  return historyCommand({ args, json: false, effects, session });
};

it('lists the facts of an instruction as json, newest first', async () => {
  const output = successOf(await history(['demo-3467', '--json']));

  expect(output.json).toEqual({ id: 'demo-3467', facts: [progress, question] });
});

it('prints one line per fact, newest first, with the first line of its text', async () => {
  const multiline = makeFact({
    kind: 'log',
    type: 'progress',
    text: 'First line\nSecond line',
    at: '2026-10-20T12:00:00.000Z',
  });

  const output = successOf(await history(['demo-3467'], [question, progress, multiline]));

  expect(output.text).toBe(
    [
      '2026-10-20T12:00:00.000Z  log/progress  First line',
      '2026-10-20T11:00:00.000Z  log/progress  Wrote the parser',
      '2026-10-20T10:00:00.000Z  log/question  Which store?',
      '',
    ].join('\n'),
  );
});

it('prints the reason of a rejection when it has no text', async () => {
  const rejection = makeFact({
    kind: 'reject',
    item: '0123456789ab',
    reason: 'Missing tests\nand docs',
    at: '2026-10-20T12:00:00.000Z',
  });

  const output = successOf(await history(['demo-3467'], [rejection]));

  expect(output.text).toBe('2026-10-20T12:00:00.000Z  reject  Missing tests\n');
});

it('refuses extra arguments and unknown options', async () => {
  expect(failureOf(await history(['demo-3467', 'demo-3468'])).code).toBe('invalidArguments');
  expect(failureOf(await history(['demo-3467', '--bogus'])).code).toBe('invalidArguments');
});

it('reports a store read failure', async () => {
  const { session } = makeSession({
    tickets: [makeTicket('demo-3467')],
    overrides: { listFacts: () => failed('The store is locked.') },
  });

  const { effects } = makeEffects();
  const result = await historyCommand({ args: ['demo-3467'], json: false, effects, session });
  const reason = failureOf(result);

  expect(reason).toEqual({ code: 'storeError', message: 'The store is locked.' });
});

it('returns notFound for an unknown ID', async () => {
  expect(failureOf(await history(['demo-9999'])).code).toBe('notFound');
});

it('refuses a missing ID with a usage message', async () => {
  const reason = failureOf(await history([]));

  expect(reason.code).toBe('invalidArguments');
  expect(reason.message).toContain('tikk history');
});
