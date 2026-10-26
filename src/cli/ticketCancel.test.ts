import { expect, it } from 'bun:test';

import { parseTicketFile } from '../ticket/ticket.ts';
import {
  failed,
  failureOf,
  makeEffects,
  makeFact,
  makeKindTicket,
  makeSession,
  makeTicket,
  successOf,
} from './cliHarness.ts';
import type { SessionOptions } from './cliHarness.ts';
import { ticketCancel } from './ticketCancel.ts';

const instruction = makeTicket('demo-3467');

const cancel = async (args: string[], options: SessionOptions = {}) => {
  const fakeSession = makeSession({ tickets: [instruction], ...options });
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

  expect(write?.path).toBe(instruction.path);
  expect(write?.expectedHash).toBe(instruction.hash);
  expect(written.ok && written.value.frontMatter.status).toBe('canceled');
  expect(written.ok && written.value.body).toBe(instruction.body);
  expect(write?.underLock).toBe(true);
  expect(fakeSession.lockHeld()).toBe(false);
});

it('cancels the ticket as it is on disk after the lock is taken', async () => {
  const fakeSession = makeSession({ tickets: [instruction] });
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

it('succeeds without a write when the instruction is already canceled', async () => {
  const canceled = makeTicket('demo-3467', {
    frontMatter: { ...instruction.frontMatter, status: 'canceled' },
  });

  const { fakeSession, result } = await cancel(['demo-3467'], { tickets: [canceled] });

  expect(successOf(result).json).toMatchObject({ state: 'canceled' });
  expect(fakeSession.writes).toEqual([]);
});

it('refuses to cancel a done instruction and writes nothing', async () => {
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

it('cancels a plan in its file and appends a status fact', async () => {
  const plan = makeKindTicket('demo-3467', 'plan');
  const { fakeSession, result } = await cancel(['demo-3467'], { tickets: [plan] });
  const [write] = fakeSession.writes;
  const written = parseTicketFile(write?.text ?? '');

  successOf(result);
  expect(write?.expectedHash).toBe(plan.hash);
  expect(written.ok && written.value.frontMatter.status).toBe('canceled');
  expect(fakeSession.appends).toHaveLength(1);

  expect(fakeSession.appends[0]).toMatchObject({
    machine: 'laptop',
    fact: { kind: 'status', ticket: 'demo-3467', status: 'canceled' },
  });
});

it('appends a status fact when it cancels an instruction', async () => {
  const { fakeSession, result } = await cancel(['demo-3467']);

  successOf(result);

  expect(fakeSession.appends.map((append) => append.fact)).toMatchObject([
    { kind: 'status', status: 'canceled' },
  ]);
});

it('cancels a task', async () => {
  const task = makeKindTicket('demo-3467', 'task');
  const { fakeSession, result } = await cancel(['demo-3467'], { tickets: [task] });

  expect(successOf(result).json).toMatchObject({ id: 'demo-3467' });
  expect(fakeSession.writes).toHaveLength(1);
  expect(fakeSession.appends).toHaveLength(1);
});

it('returns a canceled slice unchanged and appends nothing', async () => {
  const slice = makeKindTicket('demo-3467', 'slice', 'canceled');
  const { fakeSession, result } = await cancel(['demo-3467'], { tickets: [slice] });

  successOf(result);
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
});

it('refuses to cancel a done task and changes nothing', async () => {
  const done = makeKindTicket('demo-3467', 'task', 'done');
  const { fakeSession, result } = await cancel(['demo-3467'], { tickets: [done] });

  expect(failureOf(result).code).toBe('conflict');
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
});

it('reports that the file was written when the fact cannot be appended', async () => {
  const { fakeSession, result } = await cancel(['demo-3467'], {
    overrides: {
      appendFact: () =>
        Promise.resolve({ ok: false, reason: { kind: 'failed', message: 'Disk full.' } }),
    },
  });

  const failure = failureOf(result);

  expect(failure.code).toBe('storeError');
  expect(failure.message).toContain('written');
  expect(fakeSession.writes).toHaveLength(1);
});

it('refuses to cancel an instruction whose file has an error and writes nothing', async () => {
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

it('reports a storeError when the facts of an instruction cannot be read', async () => {
  const { fakeSession, result } = await cancel(['demo-3467'], {
    overrides: { listStateFacts: () => failed('The facts are damaged.') },
  });

  expect(failureOf(result).code).toBe('storeError');
  expect(fakeSession.writes).toEqual([]);
});

it('reports a plan that changed on disk', async () => {
  const plan = makeKindTicket('demo-3467', 'plan');

  const { result } = await cancel(['demo-3467'], {
    tickets: [plan],
    overrides: {
      writeTicketFile: () =>
        Promise.resolve({ ok: false, reason: { kind: 'changedOnDisk', message: 'Changed.' } }),
    },
  });

  expect(failureOf(result).code).toBe('changedOnDisk');
});
