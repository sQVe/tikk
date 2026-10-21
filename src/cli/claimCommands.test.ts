import { expect, it } from 'bun:test';

import type { Fact } from '../fact/fact.ts';
import { taskAccept, taskClaim, taskLog, taskRelease, taskSubmit } from './claimCommands.ts';
import type { CliEffects, CliSession, CommandInput, CommandResult } from './cliEffects.ts';
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
import type { FakeSession } from './cliHarness.ts';

type Command = (input: CommandInput) => Promise<CommandResult>;

interface RunOptions {
  facts?: Fact[];
  tickets?: ReturnType<typeof makeTicket>[];
  effects?: Partial<CliEffects>;
  session?: Parameters<typeof makeSession>[0];
}

const task = makeTicket('demo-3467');
const activeLease = '2026-10-20T13:00:00.000Z';

const claimBy = (holder: string): Fact =>
  makeFact({ kind: 'claim', holder, leaseEnd: activeLease });

const submittedBy = (holder: string): Fact =>
  makeFact({ kind: 'log', type: 'submitted', text: '', holder, at: '2026-10-20T11:30:00.000Z' });

const accepted = makeFact({ kind: 'accept', at: '2026-10-20T11:45:00.000Z' });

// A refusal that comes before the lock reports its own error, not `locked`.
const lockRefused: Partial<CliSession> = {
  lockStore: () =>
    Promise.resolve({
      ok: false,
      reason: { kind: 'locked', message: 'The store is locked by process 42.' },
    }),
};

const run = async (command: Command, args: string[], options: RunOptions = {}) => {
  const fakeSession = makeSession({
    tickets: options.tickets ?? [task],
    facts: options.facts ?? [],
    ...options.session,
  });

  const { effects } = makeEffects({
    session: fakeSession,
    ...(options.effects === undefined ? {} : { overrides: options.effects }),
  });

  const result = await command({ args, json: true, effects, session: fakeSession.session });

  return { fakeSession, result };
};

const expectNothingWritten = (fakeSession: FakeSession): void => {
  expect(fakeSession.appends).toEqual([]);
  expect(fakeSession.lockHeld()).toBe(false);
};

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
  expectNothingWritten(fakeSession);
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
  expectNothingWritten(fakeSession);
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
    expectNothingWritten(fakeSession);
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
    expectNothingWritten(fakeSession);
  }
});

it('refuses a claim without a holder and writes nothing', async () => {
  const { fakeSession, result } = await run(taskClaim, ['demo-3467']);

  expect(failureOf(result).code).toBe('invalidArguments');
  expectNothingWritten(fakeSession);
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
  expectNothingWritten(fakeSession);
});

it('refuses a claim on an unknown task and writes nothing', async () => {
  const { fakeSession, result } = await run(taskClaim, ['demo-3468', '--holder', 'agent']);

  expect(failureOf(result).code).toBe('notFound');
  expectNothingWritten(fakeSession);
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

  expectNothingWritten(fakeSession);
});

it('refuses a claim when the machine name is invalid and writes nothing', async () => {
  const { fakeSession, result } = await run(taskClaim, ['demo-3467', '--holder', 'agent'], {
    effects: { resolveMachine: () => failed('The host name "Bad Host" is not valid.') },
    session: { overrides: lockRefused },
  });

  expect(failureOf(result).code).toBe('invalidArguments');
  expectNothingWritten(fakeSession);
});

it('releases the lock and fails when the cache refresh fails', async () => {
  const { fakeSession, result } = await run(taskClaim, ['demo-3467', '--holder', 'agent'], {
    session: { overrides: { refresh: () => failed('The cache failed.') } },
  });

  expect(failureOf(result).code).toBe('storeError');
  expectNothingWritten(fakeSession);
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
    expectNothingWritten(fakeSession);
  }
});

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
    expectNothingWritten(fakeSession);
  }
});

it('refuses a log without text and writes nothing', async () => {
  const { fakeSession, result } = await run(taskLog, ['demo-3467', '--type', 'progress']);

  expect(failureOf(result).code).toBe('invalidArguments');
  expectNothingWritten(fakeSession);
});

it('submits a task held by the same holder', async () => {
  const { fakeSession, result } = await run(
    taskSubmit,
    ['demo-3467', '--holder', 'agent', '--text', 'Ready for review'],
    { facts: [claimBy('agent')] },
  );

  expect(successOf(result).json).toMatchObject({ state: 'submitted' });

  expect(fakeSession.appends.map(({ fact }) => fact)).toMatchObject([
    { kind: 'log', type: 'submitted', text: 'Ready for review', holder: 'agent' },
  ]);
});

it('refuses a submit by another holder and writes nothing', async () => {
  const { fakeSession, result } = await run(taskSubmit, ['demo-3467', '--holder', 'agent'], {
    facts: [claimBy('other')],
  });

  expect(failureOf(result).code).toBe('conflict');
  expectNothingWritten(fakeSession);
});

it('accepts a submitted task', async () => {
  const { fakeSession, result } = await run(taskAccept, ['demo-3467'], {
    facts: [claimBy('agent'), submittedBy('agent')],
  });

  expect(successOf(result).json).toMatchObject({ state: 'done' });
  expect(fakeSession.appends.map(({ fact }) => fact.kind)).toEqual(['accept']);
});

it('refuses to accept a task that is not submitted and writes nothing', async () => {
  for (const facts of [[], [claimBy('agent')]]) {
    const { fakeSession, result } = await run(taskAccept, ['demo-3467'], { facts });

    expect(failureOf(result).code).toBe('conflict');
    expectNothingWritten(fakeSession);
  }
});

it('refuses claim, release, submit, and accept on a task whose file has an error', async () => {
  const broken = makeTicket('demo-3467', { error: 'Bad YAML.' });

  const commands: [Command, string[]][] = [
    [taskClaim, ['demo-3467', '--holder', 'agent']],
    [taskRelease, ['demo-3467', '--holder', 'agent']],
    [taskSubmit, ['demo-3467', '--holder', 'agent']],
    [taskAccept, ['demo-3467']],
  ];

  for (const [command, args] of commands) {
    const { fakeSession, result } = await run(command, args, {
      tickets: [broken],
      facts: [claimBy('agent'), submittedBy('agent')],
    });

    expect(failureOf(result).code).toBe('parseError');
    expectNothingWritten(fakeSession);
  }
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
