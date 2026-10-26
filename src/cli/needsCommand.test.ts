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
  fakeGh,
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
    reconcileProblems: [],
  });
});

it('prints one line per item with its ID, reason, and age', async () => {
  const question = makeFact({ kind: 'log', type: 'question', text: 'Why?' });
  const output = successOf(await needs([], [makeTicket('demo-3467')], [question]));

  expect(output.text).toBe('demo-3467  question  1h  A title\n');
});

it('prints nothing when no instruction waits on the user', async () => {
  const output = successOf(await needs([], [makeTicket('demo-3467')]));

  expect(output.text).toBe('');
  expect(output.json).toEqual({ items: [], reconcileProblems: [] });
});

it('refuses a positional argument', async () => {
  const failure = failureOf(await needs(['extra'], [makeTicket('demo-3467')]));

  expect(failure.code).toBe('invalidArguments');
});

it('still lists a question on an instruction whose file no longer parses', async () => {
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
  repository: 'sqve/tikk',
  changeHash: 'hash1',
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
    reconcileProblems: [],
  });
});

it('lists a merged slice with an open instruction as flagged with the instruction ID', async () => {
  const instruction = makeTicket('demo-3478', {
    frontMatter: { ...makeTicket('demo-3478').frontMatter, parent: ticketIdOf('demo-3469') },
  });

  const slice = makeKindTicket('demo-3469', 'slice');
  const output = successOf(await needs([], [slice, instruction], [mergedFact, auditFact]));

  expect(output.json).toMatchObject({
    items: [{ id: 'demo-3469', reason: 'flagged', openInstructions: ['demo-3478'] }],
  });

  expect(output.text).toBe('demo-3469  flagged  1h  A title  demo-3478\n');
});

it('lists a merged slice with an open task as flagged with the task ID', async () => {
  const task = makeTicket('demo-3478', {
    frontMatter: {
      ...makeKindTicket('demo-3478', 'task').frontMatter,
      parent: ticketIdOf('demo-3469'),
    },
  });

  const slice = makeKindTicket('demo-3469', 'slice');
  const output = successOf(await needs([], [slice, task], [mergedFact, auditFact]));

  expect(output.json).toMatchObject({
    items: [{ id: 'demo-3469', reason: 'flagged', openInstructions: [], openTasks: ['demo-3478'] }],
  });

  expect(output.text).toBe('demo-3469  flagged  1h  A title  demo-3478\n');
});

it('still flags a merged slice whose open instruction is archived', async () => {
  const base = makeTicket('demo-3478').frontMatter;

  const instruction = makeTicket('demo-3478', {
    frontMatter: { ...base, parent: ticketIdOf('demo-3469'), archived: '2026-10-01' },
  });

  const slice = makeKindTicket('demo-3469', 'slice');
  const output = successOf(await needs([], [slice, instruction], [mergedFact, auditFact]));

  expect(output.json).toMatchObject({
    items: [{ id: 'demo-3469', reason: 'flagged', openInstructions: ['demo-3478'] }],
  });
});

it('does not flag a merged slice because of an archived canceled instruction', async () => {
  const base = makeTicket('demo-3478').frontMatter;

  const instruction = makeTicket('demo-3478', {
    frontMatter: {
      ...base,
      parent: ticketIdOf('demo-3469'),
      archived: '2026-10-01',
      status: 'canceled',
    },
  });

  const slice = makeKindTicket('demo-3469', 'slice');
  const output = successOf(await needs([], [slice, instruction], [mergedFact, auditFact]));

  expect(output.json).toEqual({ items: [], reconcileProblems: [] });
});

it('leaves out a done slice', async () => {
  const slice = makeKindTicket('demo-3469', 'slice');
  const output = successOf(await needs([], [slice], [mergedFact, auditFact]));

  expect(output.json).toEqual({ items: [], reconcileProblems: [] });
});

it('returns the list with one reconcile problem when gh fails', async () => {
  const question = makeFact({ kind: 'log', type: 'question', text: 'Why?' });

  const openPr = makeFact({
    kind: 'pr',
    ticket: 'demo-3469',
    repository: 'acme/app',
    number: 7,
    state: 'open',
    base: 'main',
    head: 'head1',
    trunk: 'main',
    inTrunk: false,
  });

  const fakeSession = makeSession({
    tickets: [makeTicket('demo-3467'), makeKindTicket('demo-3469', 'slice')],
    facts: [question, openPr],
  });

  const { effects } = makeEffects({
    session: fakeSession,
    runGh: fakeGh({ 7: { state: 'OPEN', error: 'offline' } }),
  });

  const output = successOf(
    await needsCommand({ args: [], json: true, effects, session: fakeSession.session }),
  );

  expect(output.json).toMatchObject({
    items: [expect.objectContaining({ id: 'demo-3467', reason: 'question' })],
    reconcileProblems: [expect.objectContaining({ ticket: 'demo-3469', number: 7 })],
  });

  expect(output.text).toContain('demo-3467  question');
  expect(output.text).toContain('problem: ');
});

it('prints a blocked finding with its fingerprint and claim', async () => {
  const review = makeFact({
    kind: 'review',
    target: { repository: 'tikk', head: 'aaa', base: 'main', changeHash: 'h' },
    captureHash: 'c',
    mode: 'code',
    findings: [{ fingerprint: 'fp-1', severity: 'high', location: 'a.ts:1', claim: 'Wrong' }],
  });

  const blocked = makeFact({
    kind: 'finding',
    fingerprint: 'fp-1',
    status: 'blocked',
    actor: 'agent',
    reason: 'Needs a decision',
  });

  const output = successOf(await needs([], [makeTicket('demo-3467')], [review, blocked]));

  expect(output.text).toBe('demo-3467  blockedFinding  1h  fp-1  Wrong\n');
});

const itemsJson = (output: { json: unknown }): string =>
  JSON.stringify((output.json as { items: unknown }).items);

it('keeps the key order of each reason in the JSON', async () => {
  const question = makeFact({ kind: 'log', type: 'question', text: 'Why?' });
  const questionOutput = successOf(await needs([], [makeTicket('demo-3467')], [question]));

  expect(itemsJson(questionOutput)).toBe(
    '[{"id":"demo-3467","title":"A title","reason":"question","since":"2026-10-20T11:00:00.000Z","ageSeconds":3600}]',
  );

  const ended = makeFact({ kind: 'claim', holder: 'agent', leaseEnd: '2026-10-20T11:59:00.000Z' });
  const staleOutput = successOf(await needs([], [makeTicket('demo-3467')], [ended]));

  expect(itemsJson(staleOutput)).toBe(
    '[{"id":"demo-3467","title":"A title","reason":"staleClaim","since":"2026-10-20T11:59:00.000Z","ageSeconds":60,"holder":"agent"}]',
  );

  const instruction = makeTicket('demo-3478', {
    frontMatter: { ...makeTicket('demo-3478').frontMatter, parent: ticketIdOf('demo-3469') },
  });

  const slice = makeKindTicket('demo-3469', 'slice');
  const flaggedOutput = successOf(await needs([], [slice, instruction], [mergedFact, auditFact]));

  expect(itemsJson(flaggedOutput)).toBe(
    '[{"id":"demo-3469","title":"A title","reason":"flagged","since":"2026-10-20T11:00:00.000Z","ageSeconds":3600,"openInstructions":["demo-3478"],"openTasks":[]}]',
  );

  const review = makeFact({
    kind: 'review',
    target: { repository: 'tikk', head: 'aaa', base: 'main', changeHash: 'h' },
    captureHash: 'c',
    mode: 'code',
    findings: [{ fingerprint: 'fp-1', severity: 'high', location: 'a.ts:1', claim: 'Wrong' }],
  });

  const blocked = makeFact({
    kind: 'finding',
    fingerprint: 'fp-1',
    status: 'blocked',
    actor: 'agent',
    reason: 'Needs a decision',
  });

  const broken = makeTicket('demo-3467', { error: 'Bad front matter.' });
  const blockedOutput = successOf(await needs([], [broken], [review, blocked]));
  const keys = Object.keys((JSON.parse(itemsJson(blockedOutput)) as object[])[0] ?? {});

  expect(keys).toEqual([
    'id',
    'title',
    'reason',
    'since',
    'ageSeconds',
    'fingerprint',
    'claim',
    'parseError',
  ]);
});
