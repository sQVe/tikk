import { expect, it } from 'bun:test';

import type { Fact } from '../fact/fact.ts';
import {
  fakeGh,
  makeEffects,
  makeFact,
  makeKindTicket,
  makeSession,
  ticketIdOf,
} from './cliHarness.ts';
import { reconcilePullRequests } from './prReconcile.ts';

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

  return { outcome, appends: fakeSession.appends, ghCalls: fakeEffects.ghCalls };
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
