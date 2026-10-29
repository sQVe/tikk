import { expect, it } from 'bun:test';

import { buildSliceIndex, selectSlicePr } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import { invariant } from '../invariant.ts';
import type { Result } from '../result.ts';
import { runCli } from './cli.ts';
import type { CliEffects, CliFailure, CliSession } from './cliEffects.ts';
import {
  fakeGh,
  makeEffects,
  makeFact,
  makeKindTicket,
  failed,
  failureOf,
  makeSession,
  stalledGh,
  successOf,
  ticketIdOf,
  withExpiredTimeouts,
} from './cliHarness.ts';
import type { FakeSession } from './cliHarness.ts';
import { reconcileBeforeRead, reconcileCommand, reconcilePullRequests } from './prReconcile.ts';
import type { ReconcileOutcome } from './prReconcile.ts';

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

const outcomeOf = (result: Result<ReconcileOutcome, CliFailure>): ReconcileOutcome => {
  invariant(result.ok, 'The reconcile should read the outlines.');

  return result.value;
};

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

  const result = await reconcilePullRequests({
    effects: fakeEffects.effects,
    session: fakeSession.session,
  });

  invariant(result.ok, 'The reconcile should read the outlines.');

  return {
    outcome: result.value,
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

  const outcome = outcomeOf(
    await withExpiredTimeouts(async () =>
      reconcilePullRequests({ effects, session: fakeSession.session }),
    ),
  );

  expect(outcome.updated).toEqual([]);
  expect(outcome.problems).toHaveLength(1);
  expect(outcome.problems[0]).toMatchObject({ ticket: 'demo-3467', number: 7 });
  expect(fakeSession.appends).toEqual([]);
});

it('fails with a storeError and appends nothing when the store cannot be read again', async () => {
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

  const result = await reconcilePullRequests({ effects, session: fakeSession.session });

  expect(result).toEqual({ ok: false, reason: { code: 'storeError', message: 'Cache is gone.' } });
  expect(fakeSession.appends).toEqual([]);
  expect(fakeSession.lockHeld()).toBe(false);
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
  const outcome = outcomeOf(await reconcilePullRequests({ effects, session: fakeSession.session }));

  await fakeSession.session.refresh();

  const facts = await fakeSession.session.listStateFacts();

  const tickets = fakeSession.session.listTickets({ includeArchived: true });

  const index = buildSliceIndex(tickets.ok ? tickets.value : [], facts.ok ? facts.value : []);

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

  const outcome = outcomeOf(await reconcilePullRequests({ effects, session: fakeSession.session }));

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

it('exits 1 with a JSON storeError when the ticket outlines cannot be read', async () => {
  const fakeSession = makeSession({
    tickets: [makeKindTicket('demo-3467', 'slice')],
    facts: [prFact('demo-3467', {})],
    overrides: {
      listTicketOutlines: () => ({
        ok: false,
        reason: { message: 'The cache failed: database is locked' },
      }),
    },
  });

  const fakeEffects = makeEffects({
    session: fakeSession,
    runGh: fakeGh({ 7: { state: 'OPEN' } }),
  });

  const stdout: string[] = [];
  const stderr: string[] = [];

  const exitCode = await runCli(['reconcile', '--json'], fakeEffects.effects, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });

  expect(exitCode).toBe(1);
  expect(stderr).toEqual([]);

  expect(JSON.parse(stdout.join(''))).toEqual({
    error: { code: 'storeError', message: 'The cache failed: database is locked' },
  });
});

it('exits 1 with a JSON storeError when the state facts cannot be read', async () => {
  const fakeSession = makeSession({
    tickets: [makeKindTicket('demo-3467', 'slice')],
    facts: [prFact('demo-3467', {})],
    overrides: {
      listStateFacts: () => failed('The cache failed: database is locked'),
    },
  });

  const fakeEffects = makeEffects({
    session: fakeSession,
    runGh: fakeGh({ 7: { state: 'OPEN' } }),
  });

  const stdout: string[] = [];
  const stderr: string[] = [];

  const exitCode = await runCli(['reconcile', '--json'], fakeEffects.effects, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });

  expect(exitCode).toBe(1);
  expect(stderr).toEqual([]);
  expect(fakeSession.appends).toEqual([]);

  expect(JSON.parse(stdout.join(''))).toEqual({
    error: { code: 'storeError', message: 'The cache failed: database is locked' },
  });
});

// The fake reads the lock state at call time, so a read can fail only while the store lock is held.
const runReconcileJson = async (overrides: (lockHeld: () => boolean) => Partial<CliSession>) => {
  const fakeSession: FakeSession = makeSession({
    tickets: [makeKindTicket('demo-3467', 'slice')],
    facts: [prFact('demo-3467', {})],
    overrides: overrides(() => fakeSession.lockHeld()),
  });

  const fakeEffects = makeEffects({
    session: fakeSession,
    runGh: fakeGh({ 7: { state: 'CLOSED' } }),
  });

  const stdout: string[] = [];
  const stderr: string[] = [];

  const exitCode = await runCli(['reconcile', '--json'], fakeEffects.effects, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });

  return { exitCode, stdout: stdout.join(''), stderr, fakeSession };
};

it('exits 1 with a JSON storeError when the store cannot be read again under the lock', async () => {
  const { exitCode, stdout, stderr, fakeSession } = await runReconcileJson((lockHeld) => ({
    refresh: () =>
      Promise.resolve(
        lockHeld()
          ? { ok: false, reason: { message: 'Cache is gone.' } }
          : { ok: true, value: undefined },
      ),
  }));

  expect(exitCode).toBe(1);
  expect(stderr).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
  expect(fakeSession.lockHeld()).toBe(false);

  expect(JSON.parse(stdout)).toEqual({ error: { code: 'storeError', message: 'Cache is gone.' } });
});

it('exits 1 with a JSON storeError when the facts cannot be read again under the lock', async () => {
  const { exitCode, stdout, stderr, fakeSession } = await runReconcileJson((lockHeld) => ({
    listStateFacts: () =>
      lockHeld()
        ? failed('The cache failed: database is locked')
        : Promise.resolve({ ok: true, value: [prFact('demo-3467', {})] }),
  }));

  expect(exitCode).toBe(1);
  expect(stderr).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
  expect(fakeSession.lockHeld()).toBe(false);

  expect(JSON.parse(stdout)).toEqual({
    error: { code: 'storeError', message: 'The cache failed: database is locked' },
  });
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

it('an explicit reconcile of a shared ID returns idShared and appends no fact', async () => {
  const fakeSession = makeSession({
    tickets: [makeKindTicket('demo-3467', 'slice')],
    facts: [prFact('demo-3467', {})],
    overrides: {
      appendFact: () =>
        Promise.resolve({
          ok: false as const,
          reason: {
            kind: 'shared',
            message:
              'Ticket ID demo-3467 is shared by two ticket files. Run tikk sync to resolve it.',
          },
        }),
    },
  });

  const fakeEffects = makeEffects({
    session: fakeSession,
    runGh: fakeGh({ 7: { state: 'CLOSED' } }),
  });

  const result = await reconcileCommand({
    args: [],
    json: true,
    effects: fakeEffects.effects,
    session: fakeSession.session,
  });

  expect(result.ok).toBe(false);
  expect(result.ok ? undefined : result.reason.code).toBe('idShared');
  expect(fakeSession.appends).toEqual([]);
});

it('automatic reconcile reports a problem for a shared-ID update and does not fail', async () => {
  const fakeSession = makeSession({
    tickets: [makeKindTicket('demo-3467', 'slice')],
    facts: [prFact('demo-3467', {})],
    overrides: {
      appendFact: () =>
        Promise.resolve({
          ok: false as const,
          reason: {
            kind: 'shared',
            message:
              'Ticket ID demo-3467 is shared by two ticket files. Run tikk sync to resolve it.',
          },
        }),
    },
  });

  const { effects } = makeEffects({
    session: fakeSession,
    runGh: fakeGh({ 7: { state: 'CLOSED' } }),
  });

  const result = await reconcileBeforeRead({ effects, session: fakeSession.session });

  expect(result.ok && result.value.map((problem) => [problem.ticket, problem.message])).toEqual([
    [
      'demo-3467',
      'Ticket ID demo-3467 is shared by two ticket files. Run tikk sync to resolve it.',
    ],
  ]);

  expect(fakeSession.appends).toEqual([]);
});
