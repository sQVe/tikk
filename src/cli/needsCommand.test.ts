import { expect, it } from 'bun:test';

import type { Fact } from '../fact/fact.ts';
import type { CliTicket } from './cliEffects.ts';
import {
  failureOf,
  makeEffects,
  makeFact,
  makeKindTicket,
  makeSession,
  makeTicket,
  successOf,
  ticketIdOf,
} from './cliHarness.ts';
import { needsCommand } from './needsCommand.ts';

const needs = (args: string[], tickets: CliTicket[], facts: Fact[] = []) => {
  const fakeSession = makeSession({ tickets, facts });
  const { effects } = makeEffects({ session: fakeSession });

  return needsCommand({ args, json: true, effects, session: fakeSession.session });
};

it('lists a claim whose lease ended with its holder, and not a live lease', async () => {
  const ended = makeFact({ kind: 'claim', holder: 'agent', leaseEnd: '2026-10-20T11:59:00.000Z' });

  const live = makeFact({
    kind: 'claim',
    ticket: 'demo-3468',
    holder: 'other',
    leaseEnd: '2026-10-20T12:30:00.000Z',
  });

  const output = successOf(
    await needs([], [makeTicket('demo-3467'), makeTicket('demo-3468')], [ended, live]),
  );

  expect(output.json).toEqual({
    items: [
      {
        id: 'demo-3467',
        title: 'A title',
        reason: 'staleClaim',
        since: '2026-10-20T11:59:00.000Z',
        ageSeconds: 60,
        holder: 'agent',
      },
    ],
  });
});

it('prints one line per item with its ID, reason, and age', async () => {
  const question = makeFact({ kind: 'log', type: 'question', text: 'Why?' });
  const output = successOf(await needs([], [makeTicket('demo-3467')], [question]));

  expect(output.text).toBe('demo-3467  question  1h  A title\n');
});

it('prints nothing when no task waits on the user', async () => {
  const output = successOf(await needs([], [makeTicket('demo-3467')]));

  expect(output.text).toBe('');
  expect(output.json).toEqual({ items: [] });
});

it('refuses a positional argument', async () => {
  const failure = failureOf(await needs(['extra'], [makeTicket('demo-3467')]));

  expect(failure.code).toBe('invalidArguments');
});

it('still lists a question on a task whose file no longer parses', async () => {
  const broken = makeTicket('demo-3467', { error: 'Bad front matter.' });
  const question = makeFact({ kind: 'log', type: 'question', text: 'Why?' });
  const output = successOf(await needs([], [broken], [question]));

  expect(output.json).toMatchObject({
    items: [{ id: 'demo-3467', reason: 'question', parseError: broken.path }],
  });

  expect(output.text.endsWith(`  parseError ${broken.path}\n`)).toBe(true);
});

const mergedFact = makeFact({
  ticket: 'demo-3469',
  kind: 'pr',
  repository: 'sqve/tikk',
  number: 7,
  state: 'merged',
  base: 'main',
  head: 'aaa',
  trunk: 'main',
  inTrunk: true,
});

const auditFact = makeFact({
  ticket: 'demo-3469',
  kind: 'audit',
  head: 'aaa',
  base: 'main',
  verdicts: [{ criterion: 'It works.', verdict: 'met', evidence: 'Ran it.' }],
});

it('lists a merged slice with no audit as mergedUnverified', async () => {
  const output = successOf(await needs([], [makeKindTicket('demo-3469', 'slice')], [mergedFact]));

  expect(output.json).toEqual({
    items: [
      {
        id: 'demo-3469',
        title: 'A title',
        reason: 'mergedUnverified',
        since: '2026-10-20T11:00:00.000Z',
        ageSeconds: 3600,
      },
    ],
  });
});

it('lists a merged slice with an open task as flagged with the task ID', async () => {
  const task = makeTicket('demo-3478', {
    frontMatter: { ...makeTicket('demo-3478').frontMatter, parent: ticketIdOf('demo-3469') },
  });

  const slice = makeKindTicket('demo-3469', 'slice');
  const output = successOf(await needs([], [slice, task], [mergedFact, auditFact]));

  expect(output.json).toMatchObject({
    items: [{ id: 'demo-3469', reason: 'flagged', openTasks: ['demo-3478'] }],
  });

  expect(output.text).toBe('demo-3469  flagged  1h  A title  demo-3478\n');
});

it('leaves out a done slice', async () => {
  const slice = makeKindTicket('demo-3469', 'slice');
  const output = successOf(await needs([], [slice], [mergedFact, auditFact]));

  expect(output.json).toEqual({ items: [] });
});
