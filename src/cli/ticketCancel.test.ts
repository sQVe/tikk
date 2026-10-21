import { expect, it } from 'bun:test';

import { parseTicketFile } from '../ticket/ticket.ts';
import {
  failureOf,
  makeEffects,
  makeFact,
  makeSession,
  makeTicket,
  projectNameOf,
  successOf,
} from './cliHarness.ts';
import type { SessionOptions } from './cliHarness.ts';
import { ticketCancel } from './ticketCancel.ts';

const task = makeTicket('demo-3467');

const cancel = async (args: string[], options: SessionOptions = {}) => {
  const fakeSession = makeSession({ tickets: [task], ...options });
  const { effects } = makeEffects({ session: fakeSession });
  const result = await ticketCancel({ args, json: true, effects, session: fakeSession.session });

  return { fakeSession, result };
};

it('writes status canceled with the expected hash under the lock', async () => {
  const { fakeSession, result } = await cancel(['demo-3467']);
  const [write] = fakeSession.writes;
  const written = parseTicketFile(write?.text ?? '');

  expect(successOf(result).json).toMatchObject({
    id: 'demo-3467',
    hash: 'new-hash',
    status: 'canceled',
    state: 'canceled',
  });

  expect(write?.path).toBe(task.path);
  expect(write?.expectedHash).toBe(task.hash);
  expect(written.ok && written.value.frontMatter.status).toBe('canceled');
  expect(written.ok && written.value.body).toBe(task.body);
  expect(write?.underLock).toBe(true);
  expect(fakeSession.lockHeld()).toBe(false);
});

it('cancels the ticket as it is on disk after the lock is taken', async () => {
  const fakeSession = makeSession({ tickets: [task] });
  const { effects } = makeEffects({ session: fakeSession });
  const lockStore = fakeSession.session.lockStore;

  fakeSession.session.lockStore = async () => {
    fakeSession.changeOnDisk(makeTicket('demo-3467', { hash: 'hash-changed' }));

    return lockStore();
  };

  const result = await ticketCancel({
    args: ['demo-3467'],
    json: true,
    effects,
    session: fakeSession.session,
  });

  successOf(result);
  expect(fakeSession.writes.map((write) => write.expectedHash)).toEqual(['hash-changed']);
  expect(fakeSession.lockHeld()).toBe(false);
});

it('succeeds without a write when the task is already canceled', async () => {
  const canceled = makeTicket('demo-3467', {
    frontMatter: { ...task.frontMatter, status: 'canceled' },
  });

  const { fakeSession, result } = await cancel(['demo-3467'], { tickets: [canceled] });

  expect(successOf(result).json).toMatchObject({ state: 'canceled' });
  expect(fakeSession.writes).toEqual([]);
});

it('refuses to cancel a done task and writes nothing', async () => {
  const facts = [
    makeFact({ kind: 'log', type: 'submitted', text: '' }),
    makeFact({ kind: 'accept', at: '2026-10-20T11:30:00.000Z' }),
  ];

  const { fakeSession, result } = await cancel(['demo-3467'], { facts });

  expect(failureOf(result).code).toBe('conflict');
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
  expect(fakeSession.lockHeld()).toBe(false);
});

it('refuses to cancel an issue and writes nothing', async () => {
  const issue = makeTicket('demo-3467', {
    frontMatter: {
      kind: 'issue',
      title: 'An issue',
      project: projectNameOf('demo'),
      blockedBy: [],
      status: 'open',
    },
  });

  const { fakeSession, result } = await cancel(['demo-3467'], { tickets: [issue] });

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses to cancel a task whose file has an error and writes nothing', async () => {
  const broken = makeTicket('demo-3467', { error: 'Duplicate ID.' });
  const { fakeSession, result } = await cancel(['demo-3467'], { tickets: [broken] });

  expect(failureOf(result).code).toBe('parseError');
  expect(fakeSession.writes).toEqual([]);
});

it('reports a file that changed on disk', async () => {
  const { result } = await cancel(['demo-3467'], {
    overrides: {
      writeTicketFile: () =>
        Promise.resolve({ ok: false, reason: { kind: 'changedOnDisk', message: 'Changed.' } }),
    },
  });

  expect(failureOf(result).code).toBe('changedOnDisk');
});

it('refuses a missing ID before it takes the lock', async () => {
  const { result } = await cancel([], {
    overrides: {
      lockStore: () =>
        Promise.resolve({
          ok: false,
          reason: { kind: 'locked', message: 'The store is locked by process 42.' },
        }),
    },
  });

  expect(failureOf(result).code).toBe('invalidArguments');
});
