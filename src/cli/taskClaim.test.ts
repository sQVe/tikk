import { expect, it } from 'bun:test';

import {
  failed,
  failureOf,
  makeEffects,
  makeFact,
  makeSession,
  makeTicket,
  projectNameOf,
  successOf,
} from './cliHarness.ts';
import { taskClaim, taskRelease } from './taskClaim.ts';
import {
  task,
  claimBy,
  submittedBy,
  accepted,
  lockRefused,
  run,
  noSideEffects,
  sideEffectsOf,
  orphan,
  parentOnly,
  blockedOnly,
} from './taskHarness.ts';
import type { RunOptions } from './taskHarness.ts';

it('claims an open task under the lock with a lease from now', async () => {
  const { fakeSession, result } = await run(taskClaim, [
    'demo-3467',
    '--holder',
    'agent',
    '--lease',
    '30m',
    '--session',
    'session-1',
  ]);

  expect(successOf(result).json).toMatchObject({
    id: 'demo-3467',
    state: 'active',
    claim: { holder: 'agent', leaseEnd: '2026-10-20T12:30:00.000Z', session: 'session-1' },
  });

  expect(fakeSession.appends).toEqual([
    {
      machine: 'laptop',
      fact: {
        version: 1,
        kind: 'claim',
        ticket: task.id,
        at: '2026-10-20T12:00:00.000Z',
        machine: 'laptop',
        holder: 'agent',
        leaseEnd: '2026-10-20T12:30:00.000Z',
        session: 'session-1',
      },
    },
  ]);

  expect(fakeSession.lockHeld()).toBe(false);
});

it('checks the task as it is on disk after the lock is taken', async () => {
  const fakeSession = makeSession({ tickets: [task] });
  const { effects } = makeEffects({ session: fakeSession });
  const lockStore = fakeSession.session.lockStore;

  const canceled = makeTicket('demo-3467', {
    frontMatter: { ...task.frontMatter, status: 'canceled' },
  });

  fakeSession.session.lockStore = async () => {
    fakeSession.changeOnDisk(canceled);

    return lockStore();
  };

  const result = await taskClaim({
    args: ['demo-3467', '--holder', 'agent'],
    json: true,
    effects,
    session: fakeSession.session,
  });

  expect(failureOf(result).code).toBe('conflict');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('claims for one hour when no lease is given', async () => {
  const { result } = await run(taskClaim, ['demo-3467', '--holder', 'agent']);

  expect(successOf(result).json).toMatchObject({
    claim: { leaseEnd: '2026-10-20T13:00:00.000Z' },
  });
});

it('renews the lease of the same holder', async () => {
  const { fakeSession, result } = await run(
    taskClaim,
    ['demo-3467', '--holder', 'agent', '--lease', '2h'],
    { facts: [claimBy('agent')] },
  );

  expect(successOf(result).json).toMatchObject({
    claim: { holder: 'agent', leaseEnd: '2026-10-20T14:00:00.000Z' },
  });

  expect(fakeSession.appends).toHaveLength(1);
});

it('claims a task whose earlier lease ended', async () => {
  const stale = makeFact({ kind: 'claim', holder: 'other', leaseEnd: '2026-10-20T11:30:00.000Z' });
  const { result } = await run(taskClaim, ['demo-3467', '--holder', 'agent'], { facts: [stale] });

  expect(successOf(result).json).toMatchObject({ state: 'active', claim: { holder: 'agent' } });
});

it('refuses a claim on a task another holder has and writes nothing', async () => {
  const { fakeSession, result } = await run(taskClaim, ['demo-3467', '--holder', 'agent'], {
    facts: [claimBy('other')],
  });

  expect(failureOf(result).code).toBe('conflict');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('refuses a claim on a task that is not open and writes nothing', async () => {
  const cases: RunOptions[] = [
    { facts: [claimBy('other'), submittedBy('other')] },
    { facts: [claimBy('other'), submittedBy('other'), accepted] },
    {
      tickets: [makeTicket('demo-3467', { frontMatter: { ...task.frontMatter, status: 'draft' } })],
    },
    {
      tickets: [
        makeTicket('demo-3467', { frontMatter: { ...task.frontMatter, status: 'canceled' } }),
      ],
    },
  ];

  for (const options of cases) {
    const { fakeSession, result } = await run(
      taskClaim,
      ['demo-3467', '--holder', 'agent'],
      options,
    );

    expect(failureOf(result).code).toBe('conflict');
    expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
  }
});

it('refuses a claim with an invalid lease before it takes the lock', async () => {
  for (const lease of ['0s', '10', '5d', '-1m']) {
    const { fakeSession, result } = await run(
      taskClaim,
      ['demo-3467', '--holder', 'agent', `--lease=${lease}`],
      { session: { overrides: lockRefused } },
    );

    expect(failureOf(result).code).toBe('invalidArguments');
    expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
  }
});

it('refuses a claim without a holder and writes nothing', async () => {
  const { fakeSession, result } = await run(taskClaim, ['demo-3467']);

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('refuses a claim on an issue and writes nothing', async () => {
  const issue = makeTicket('demo-3467', {
    frontMatter: {
      kind: 'issue',
      title: 'An issue',
      project: projectNameOf('demo'),
      blockedBy: [],
      discoveredFrom: [],
      related: [],
      status: 'open',
    },
  });

  const { fakeSession, result } = await run(taskClaim, ['demo-3467', '--holder', 'agent'], {
    tickets: [issue],
  });

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('refuses a claim on an unknown task and writes nothing', async () => {
  const { fakeSession, result } = await run(taskClaim, ['demo-3468', '--holder', 'agent']);

  expect(failureOf(result).code).toBe('notFound');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('fails with locked when the store lock is held and writes nothing', async () => {
  const { fakeSession, result } = await run(taskClaim, ['demo-3467', '--holder', 'agent'], {
    session: {
      overrides: {
        lockStore: () =>
          Promise.resolve({
            ok: false,
            reason: { kind: 'locked', message: 'The store is locked by process 42.' },
          }),
      },
    },
  });

  expect(failureOf(result)).toEqual({
    code: 'locked',
    message: 'The store is locked by process 42.',
  });

  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('refuses a claim when the machine name is invalid and writes nothing', async () => {
  const { fakeSession, result } = await run(taskClaim, ['demo-3467', '--holder', 'agent'], {
    effects: { resolveMachine: () => failed('The host name "Bad Host" is not valid.') },
    session: { overrides: lockRefused },
  });

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('releases the lock and fails when the cache refresh fails', async () => {
  const { fakeSession, result } = await run(taskClaim, ['demo-3467', '--holder', 'agent'], {
    session: { overrides: { refresh: () => failed('The cache failed.') } },
  });

  expect(failureOf(result).code).toBe('storeError');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('reports a failed append as a store error and releases the lock', async () => {
  const { fakeSession, result } = await run(taskClaim, ['demo-3467', '--holder', 'agent'], {
    session: {
      overrides: {
        appendFact: () =>
          Promise.resolve({ ok: false, reason: { kind: 'failed', message: 'Cannot write.' } }),
      },
    },
  });

  expect(failureOf(result).code).toBe('storeError');
  expect(fakeSession.lockHeld()).toBe(false);
});

it('releases a task held by the same holder', async () => {
  const { fakeSession, result } = await run(taskRelease, ['demo-3467', '--holder', 'agent'], {
    facts: [claimBy('agent')],
  });

  expect(successOf(result).json).toMatchObject({ state: 'open', claim: null });

  expect(fakeSession.appends.map(({ fact }) => fact)).toMatchObject([
    { kind: 'release', holder: 'agent' },
  ]);
});

it('refuses a release by another holder or of an open task and writes nothing', async () => {
  for (const facts of [[claimBy('other')], []]) {
    const { fakeSession, result } = await run(taskRelease, ['demo-3467', '--holder', 'agent'], {
      facts,
    });

    expect(failureOf(result).code).toBe('conflict');
    expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
  }
});

it('refuses a lease longer than 30 days before it takes the lock', async () => {
  for (const lease of ['721h', '999999999999999999h']) {
    const { result } = await run(taskClaim, ['demo-3467', '--holder', 'agent', '--lease', lease], {
      session: { overrides: lockRefused },
    });

    expect(failureOf(result).code).toBe('invalidArguments');
  }

  const { result } = await run(taskClaim, ['demo-3467', '--holder', 'agent', '--lease', '720h']);

  expect(successOf(result).json).toMatchObject({ claim: { leaseEnd: '2026-11-19T12:00:00.000Z' } });
});

it('refuses to claim a task whose parent does not exist and appends nothing', async () => {
  const { fakeSession, result } = await run(taskClaim, ['demo-3467', '--holder', 'agent'], {
    tickets: [parentOnly()],
  });

  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('demo-4789');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('refuses to claim a task whose parent file has an error and appends nothing', async () => {
  const parent = { ...makeTicket('demo-4789'), error: 'Broken.' };

  parent.frontMatter = { ...parent.frontMatter, kind: 'slice' };

  const { fakeSession, result } = await run(taskClaim, ['demo-3467', '--holder', 'agent'], {
    tickets: [parentOnly(), parent],
  });

  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('demo-4789');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('refuses to claim a task blocked by a ticket whose file has an error', async () => {
  const blocker = { ...makeTicket('demo-6789'), error: 'Broken.' };

  const { fakeSession, result } = await run(taskClaim, ['demo-3467', '--holder', 'agent'], {
    tickets: [blockedOnly(), blocker],
  });

  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('demo-6789');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('refuses to claim a task blocked by a ticket that does not exist and appends nothing', async () => {
  const { fakeSession, result } = await run(taskClaim, ['demo-3467', '--holder', 'agent'], {
    tickets: [blockedOnly()],
  });

  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('demo-6789');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('claims past a failed tree check with --force --reason and records the reason', async () => {
  const { fakeSession, result } = await run(
    taskClaim,
    ['demo-3467', '--holder', 'agent', '--force', '--reason', 'Parent was deleted'],
    { tickets: [orphan()] },
  );

  successOf(result);
  expect(fakeSession.appends).toHaveLength(1);

  expect(fakeSession.appends[0]?.fact).toMatchObject({
    kind: 'claim',
    forced: 'Parent was deleted',
  });
});

it('refuses --force without --reason and changes nothing', async () => {
  const { fakeSession, result } = await run(
    taskClaim,
    ['demo-3467', '--holder', 'agent', '--force'],
    { tickets: [orphan()] },
  );

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});

it('refuses --reason without --force and changes nothing', async () => {
  const { fakeSession, result } = await run(
    taskClaim,
    ['demo-3467', '--holder', 'agent', '--reason', 'Because'],
    { tickets: [task] },
  );

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(sideEffectsOf(fakeSession)).toEqual(noSideEffects);
});
