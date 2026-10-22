import { expect, it } from 'bun:test';

import { buildSliceIndex, selectSlicePr } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import type { CliEffects } from './cliEffects.ts';
import {
  fakeGh,
  makeEffects,
  makeFact,
  makeKindTicket,
  failureOf,
  makeSession,
  stalledGh,
  successOf,
  ticketIdOf,
  withExpiredTimeouts,
} from './cliHarness.ts';
import { reconcileBeforeRead, reconcileCommand, reconcilePullRequests } from './prReconcile.ts';

const prFact = (ticket: string, fields: Record<string, unknown>): Fact =>
  makeFact({
    kind: 'pr',
    ticket,
    repository: 'acme/app',
    number: 7,
    state: 'open',
    base: 'main',
    head: 'head1',
    trunk: 'main',
    inTrunk: false,
    ...fields,
  });

const reconcile = async (
  slices: string[],
  facts: Fact[],
  gh: Parameters<typeof fakeGh>[0],
  overrides: Parameters<typeof makeEffects>[0] = {},
) => {
  const fakeSession = makeSession({
    tickets: slices.map((id) => makeKindTicket(id, 'slice')),
    facts,
  });

  const fakeEffects = makeEffects({ session: fakeSession, runGh: fakeGh(gh), ...overrides });

  const outcome = await reconcilePullRequests({
    effects: fakeEffects.effects,
    session: fakeSession.session,
  });

  return {
    outcome,
    appends: fakeSession.appends,
    ghCalls: fakeEffects.ghCalls,
    scheduleCalls: fakeEffects.scheduleCalls,
  };
};

it('appends a merged fact when gh reports an open PR as merged', async () => {
  const { outcome, appends } = await reconcile(['demo-3467'], [prFact('demo-3467', {})], {
    7: { state: 'MERGED', mergeCommit: 'merge1' },
  });

  expect(outcome.checked).toEqual([ticketIdOf('demo-3467')]);
  expect(outcome.updated).toEqual([{ id: ticketIdOf('demo-3467'), state: 'merged' }]);
  expect(outcome.problems).toEqual([]);
  expect(appends).toHaveLength(1);

  expect(appends[0]?.fact).toMatchObject({
    kind: 'pr',
    ticket: 'demo-3467',
    repository: 'acme/app',
    number: 7,
    state: 'merged',
    base: 'main',
    head: 'head1',
    mergeCommit: 'merge1',
    trunk: 'main',
    inTrunk: true,
  });
});

it('appends a merged fact when gh reports a closed PR as merged after it reopened', async () => {
  const { outcome, appends } = await reconcile(
    ['demo-3467'],
    [prFact('demo-3467', { state: 'closed' })],
    { 7: { state: 'MERGED', mergeCommit: 'merge1' } },
  );

  expect(outcome.checked).toEqual([ticketIdOf('demo-3467')]);
  expect(outcome.updated).toEqual([{ id: ticketIdOf('demo-3467'), state: 'merged' }]);
  expect(appends[0]?.fact).toMatchObject({ kind: 'pr', state: 'merged', mergeCommit: 'merge1' });
});

it('appends nothing when gh reports what the newest fact already says', async () => {
  const { outcome, appends } = await reconcile(['demo-3467'], [prFact('demo-3467', {})], {
    7: { state: 'OPEN' },
  });

  expect(outcome.checked).toEqual([ticketIdOf('demo-3467')]);
  expect(outcome.updated).toEqual([]);
  expect(appends).toEqual([]);
});

it('does not call gh for a PR that is merged in trunk', async () => {
  const merged = prFact('demo-3467', { state: 'merged', mergeCommit: 'merge1', inTrunk: true });
  const { outcome, ghCalls } = await reconcile(['demo-3467'], [merged], {});

  expect(outcome).toEqual({ checked: [], updated: [], problems: [] });
  expect(ghCalls).toEqual([]);
});

it('appends a fact when only the trunk membership of a merged PR changes', async () => {
  const outsideTrunk = prFact('demo-3467', {
    state: 'merged',
    base: 'release',
    mergeCommit: 'merge1',
    inTrunk: false,
  });

  const { appends } = await reconcile(['demo-3467'], [outsideTrunk], {
    7: { state: 'MERGED', base: 'release', mergeCommit: 'merge1', compare: 'behind' },
  });

  expect(appends).toHaveLength(1);
  expect(appends[0]?.fact).toMatchObject({ base: 'release', inTrunk: true });
});

it('marks a PR merged into another branch in trunk when the compare says behind', async () => {
  const { appends } = await reconcile(['demo-3467'], [prFact('demo-3467', {})], {
    7: { state: 'MERGED', base: 'release', mergeCommit: 'merge1', compare: 'behind' },
  });

  expect(appends[0]?.fact).toMatchObject({ base: 'release', inTrunk: true });
});

it('keeps a PR merged into another branch out of trunk when the compare says ahead', async () => {
  const { appends } = await reconcile(['demo-3467'], [prFact('demo-3467', {})], {
    7: { state: 'MERGED', base: 'release', mergeCommit: 'merge1', compare: 'ahead' },
  });

  expect(appends[0]?.fact).toMatchObject({ base: 'release', inTrunk: false });
});

it('returns one problem and appends nothing when the compare status is unknown', async () => {
  const { outcome, appends } = await reconcile(['demo-3467'], [prFact('demo-3467', {})], {
    7: { state: 'MERGED', base: 'release', mergeCommit: 'merge1', compare: 'unknown' },
  });

  expect(outcome.updated).toEqual([]);
  expect(outcome.problems).toHaveLength(1);
  expect(outcome.problems[0]).toMatchObject({ ticket: 'demo-3467', number: 7 });
  expect(appends).toEqual([]);
});

it('returns one problem and appends nothing when gh does not answer before its timeout', async () => {
  const fakeSession = makeSession({
    tickets: [makeKindTicket('demo-3467', 'slice')],
    facts: [prFact('demo-3467', {})],
  });

  const { effects } = makeEffects({ session: fakeSession, runGh: stalledGh });

  const outcome = await withExpiredTimeouts(async () =>
    reconcilePullRequests({ effects, session: fakeSession.session }),
  );

  expect(outcome.updated).toEqual([]);
  expect(outcome.problems).toHaveLength(1);
  expect(outcome.problems[0]).toMatchObject({ ticket: 'demo-3467', number: 7 });
  expect(fakeSession.appends).toEqual([]);
});

it('returns one problem and appends nothing when the store cannot be read again', async () => {
  const fakeSession = makeSession({
    tickets: [makeKindTicket('demo-3467', 'slice')],
    facts: [prFact('demo-3467', {})],
    overrides: {
      refresh: () => Promise.resolve({ ok: false, reason: { message: 'Cache is gone.' } }),
    },
  });

  const { effects } = makeEffects({
    session: fakeSession,
    runGh: fakeGh({ 7: { state: 'CLOSED' } }),
  });

  const outcome = await reconcilePullRequests({ effects, session: fakeSession.session });

  expect(outcome.updated).toEqual([]);

  expect(outcome.problems).toEqual([
    { ticket: null, repository: null, number: null, message: 'Cache is gone.' },
  ]);

  expect(fakeSession.appends).toEqual([]);
});

it('keeps a PR linked by another process while gh reads the old PR', async () => {
  const fakeSession = makeSession({
    tickets: [makeKindTicket('demo-3467', 'slice')],
    facts: [prFact('demo-3467', { number: 7 })],
  });

  const github = fakeGh({ 7: { state: 'MERGED', mergeCommit: 'merge1' } });

  const runGh: CliEffects['runGh'] = async (args, signal) => {
    if (args[0] === 'pr') {
      await fakeSession.session.appendFact('other', prFact('demo-3467', { number: 8 }));
    }

    return github(args, signal);
  };

  const { effects } = makeEffects({ session: fakeSession, runGh });
  const outcome = await reconcilePullRequests({ effects, session: fakeSession.session });

  await fakeSession.session.refresh();

  const facts = await fakeSession.session.listStateFacts();

  const index = buildSliceIndex(
    fakeSession.session.listTicketOutlines(),
    facts.ok ? facts.value : [],
  );

  expect(outcome.updated).toEqual([]);
  expect(selectSlicePr(ticketIdOf('demo-3467'), index)?.number).toBe(8);
});

it('returns one problem for a failing PR and still updates the next', async () => {
  const facts = [prFact('demo-3467', { number: 7 }), prFact('demo-3468', { number: 8 })];

  const { outcome, appends } = await reconcile(['demo-3467', 'demo-3468'], facts, {
    7: { state: 'OPEN', error: 'rate limited' },
    8: { state: 'CLOSED' },
  });

  expect(outcome.updated).toEqual([{ id: ticketIdOf('demo-3468'), state: 'closed' }]);
  expect(outcome.problems).toHaveLength(1);

  expect(outcome.problems[0]).toMatchObject({
    ticket: 'demo-3467',
    repository: 'acme/app',
    number: 7,
  });

  expect(outcome.problems[0]?.message).toContain('rate limited');
  expect(appends.map((append) => append.fact.ticket)).toEqual([ticketIdOf('demo-3468')]);
});

it('returns one problem without ticket and appends nothing when the machine is unknown', async () => {
  const { outcome, appends } = await reconcile(
    ['demo-3467'],
    [prFact('demo-3467', {})],
    { 7: { state: 'CLOSED' } },
    {
      overrides: {
        resolveMachine: () => Promise.resolve({ ok: false, reason: { message: 'No machine.' } }),
      },
    },
  );

  expect(outcome.updated).toEqual([]);

  expect(outcome.problems).toEqual([
    { ticket: null, repository: null, number: null, message: 'No machine.' },
  ]);

  expect(appends).toEqual([]);
});

it('returns one problem without ticket and appends nothing when the store is locked', async () => {
  const fakeSession = makeSession({
    tickets: [makeKindTicket('demo-3467', 'slice')],
    facts: [prFact('demo-3467', {})],
    overrides: {
      lockStore: () =>
        Promise.resolve({ ok: false, reason: { kind: 'locked', message: 'Store is locked.' } }),
    },
  });

  const { effects } = makeEffects({
    session: fakeSession,
    runGh: fakeGh({ 7: { state: 'CLOSED' } }),
  });

  const outcome = await reconcilePullRequests({ effects, session: fakeSession.session });

  expect(outcome.updated).toEqual([]);

  expect(outcome.problems).toEqual([
    { ticket: null, repository: null, number: null, message: 'Store is locked.' },
  ]);

  expect(fakeSession.appends).toEqual([]);
});

it('schedules a sync after a reconcile that appended', async () => {
  const { scheduleCalls } = await reconcile(['demo-3467'], [prFact('demo-3467', {})], {
    7: { state: 'MERGED', mergeCommit: 'merge1' },
  });

  expect(scheduleCalls()).toBe(1);
});

it('schedules no sync after a reconcile that appended nothing', async () => {
  const { scheduleCalls } = await reconcile(['demo-3467'], [prFact('demo-3467', {})], {
    7: { state: 'OPEN' },
  });

  expect(scheduleCalls()).toBe(0);
});

const readReconciled = async (gh: Parameters<typeof fakeGh>[0]) => {
  let refreshes = 0;

  const fakeSession = makeSession({
    tickets: [makeKindTicket('demo-3467', 'slice')],
    facts: [prFact('demo-3467', {})],
    overrides: {
      refresh: () => {
        refreshes += 1;

        return Promise.resolve({ ok: true, value: undefined });
      },
    },
  });

  const { effects } = makeEffects({ session: fakeSession, runGh: fakeGh(gh) });
  const result = await reconcileBeforeRead({ effects, session: fakeSession.session });

  return { result, refreshes: () => refreshes };
};

it('refreshes the session after a reconcile that appended', async () => {
  const { result, refreshes } = await readReconciled({
    7: { state: 'MERGED', mergeCommit: 'merge1' },
  });

  expect(result).toEqual({ ok: true, value: [] });
  // One refresh under the lock checks the selected PR, and one after the append shows the new fact.
  expect(refreshes()).toBe(2);
});

it('does not refresh the session after a reconcile that appended nothing', async () => {
  const { result, refreshes } = await readReconciled({ 7: { state: 'OPEN' } });

  expect(result).toEqual({ ok: true, value: [] });
  expect(refreshes()).toBe(0);
});

const reconcileArguments = async (args: string[]) => {
  const fakeSession = makeSession({
    tickets: [makeKindTicket('demo-3467', 'slice')],
    facts: [prFact('demo-3467', {})],
  });

  const fakeEffects = makeEffects({
    session: fakeSession,
    runGh: fakeGh({ 7: { state: 'OPEN' } }),
  });

  const result = await reconcileCommand({
    args,
    json: true,
    effects: fakeEffects.effects,
    session: fakeSession.session,
  });

  return { result, ghCalls: fakeEffects.ghCalls, appends: fakeSession.appends };
};

it('refuses a positional argument with the usage and calls no gh', async () => {
  const { result, ghCalls, appends } = await reconcileArguments(['demo-3467']);
  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('Usage: tikk reconcile');
  expect(ghCalls).toEqual([]);
  expect(appends).toEqual([]);
});

it('refuses an unknown flag and calls no gh', async () => {
  const { result, ghCalls } = await reconcileArguments(['--force']);

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(ghCalls).toEqual([]);
});

it('lists the slices it checked and updated', async () => {
  const { result } = await reconcileArguments([]);

  expect(successOf(result).json).toEqual({
    checked: ['demo-3467'],
    updated: [],
    problems: [],
  });
});
