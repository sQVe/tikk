import { expect, it } from 'bun:test';

import type { Fact } from '../fact/fact.ts';
import {
  failureOf,
  fakeGh,
  makeEffects,
  makeFact,
  makeKindTicket,
  makeSession,
  stalledGh,
  successOf,
  withExpiredTimeouts,
} from './cliHarness.ts';
import { prCommand } from './prLink.ts';

const url = 'https://github.com/acme/app/pull/7';

const link = async (
  args: string[],
  gh: Parameters<typeof fakeGh>[0],
  options: {
    kind?: 'slice' | 'task';
    facts?: Fact[];
    appendFailure?: { kind: 'invalid' | 'failed'; message: string };
  } = {},
) => {
  const { appendFailure: reason } = options;

  const failing =
    reason === undefined
      ? {}
      : { appendFact: () => Promise.resolve({ ok: false as const, reason }) };

  const fakeSession = makeSession({
    tickets: [makeKindTicket('demo-3467', options.kind ?? 'slice')],
    facts: options.facts ?? [],
    overrides: failing,
  });

  const fakeEffects = makeEffects({ session: fakeSession, runGh: fakeGh(gh) });

  const result = await prCommand({
    args: ['link', ...args],
    json: true,
    effects: fakeEffects.effects,
    session: fakeSession.session,
  });

  return { result, appends: fakeSession.appends, ghCalls: fakeEffects.ghCalls };
};

const prFact = (number: number) =>
  makeFact({
    kind: 'pr',
    repository: 'acme/app',
    number,
    state: 'open',
    base: 'main',
    head: 'head1',
    trunk: 'main',
    inTrunk: false,
  });

it('links an open PR and shows the slice as in review', async () => {
  const { result, appends } = await link(['demo-3467', url], { 7: { state: 'OPEN' } });

  expect(appends).toHaveLength(1);

  expect(appends[0]?.fact).toMatchObject({
    kind: 'pr',
    ticket: 'demo-3467',
    repository: 'acme/app',
    number: 7,
    state: 'open',
    inTrunk: false,
  });

  expect(successOf(result).json).toMatchObject({ id: 'demo-3467', state: 'inReview' });
});

it('links a closed PR', async () => {
  const { appends } = await link(['demo-3467', url], { 7: { state: 'CLOSED' } });

  expect(appends[0]?.fact).toMatchObject({ kind: 'pr', state: 'closed' });
});

it('appends nothing when the same PR is linked again unchanged', async () => {
  const known = makeFact({
    kind: 'pr',
    repository: 'acme/app',
    number: 7,
    state: 'open',
    base: 'main',
    head: 'head1',
    trunk: 'main',
    inTrunk: false,
  });

  const { result, appends } = await link(
    ['demo-3467', url],
    { 7: { state: 'OPEN' } },
    { facts: [known] },
  );

  expect(result.ok).toBe(true);
  expect(appends).toEqual([]);
});

it('selects an earlier PR again when it is linked after a later one', async () => {
  const { result, appends } = await link(
    ['demo-3467', url],
    { 7: { state: 'OPEN' } },
    { facts: [prFact(7), prFact(8)] },
  );

  expect(appends).toHaveLength(1);
  expect(appends[0]?.fact).toMatchObject({ kind: 'pr', number: 7 });
  expect(successOf(result).json).toMatchObject({ pr: { number: 7 } });
});

it('refuses a task ticket and does not call gh', async () => {
  const { result, appends, ghCalls } = await link(
    ['demo-3467', url],
    { 7: { state: 'OPEN' } },
    { kind: 'task' },
  );

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(appends).toEqual([]);
  expect(ghCalls).toEqual([]);
});

it('refuses a URL that is not a pull request URL', async () => {
  const { result, appends, ghCalls } = await link(
    ['demo-3467', 'https://github.com/acme/app/issues/7'],
    { 7: { state: 'OPEN' } },
  );

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(appends).toEqual([]);
  expect(ghCalls).toEqual([]);
});

it('returns ghError and appends nothing when gh fails', async () => {
  const { result, appends } = await link(['demo-3467', url], {
    7: { state: 'OPEN', error: 'not logged in' },
  });

  const failure = failureOf(result);

  expect(failure.code).toBe('ghError');
  expect(failure.message).toContain('not logged in');
  expect(appends).toEqual([]);
});

it('reports a fact the store refuses as invalid arguments', async () => {
  const appendFailure = { kind: 'invalid' as const, message: 'Fact is wrong.' };
  const { result } = await link(['demo-3467', url], { 7: { state: 'OPEN' } }, { appendFailure });

  expect(failureOf(result)).toMatchObject({ code: 'invalidArguments', message: 'Fact is wrong.' });
});

it('reports a store write failure as a store error', async () => {
  const appendFailure = { kind: 'failed' as const, message: 'Disk is full.' };
  const { result } = await link(['demo-3467', url], { 7: { state: 'OPEN' } }, { appendFailure });

  expect(failureOf(result)).toMatchObject({ code: 'storeError', message: 'Disk is full.' });
});

it('returns ghError and appends nothing when gh does not answer before its timeout', async () => {
  const fakeSession = makeSession({ tickets: [makeKindTicket('demo-3467', 'slice')] });
  const fakeEffects = makeEffects({ session: fakeSession, runGh: stalledGh });

  const result = await withExpiredTimeouts(async () =>
    prCommand({
      args: ['link', 'demo-3467', url],
      json: true,
      effects: fakeEffects.effects,
      session: fakeSession.session,
    }),
  );

  expect(failureOf(result).code).toBe('ghError');
  expect(fakeSession.appends).toEqual([]);
});
