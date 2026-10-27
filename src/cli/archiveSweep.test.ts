import { expect, it } from 'bun:test';

import type { Fact } from '../fact/fact.ts';
import { parseTicketFile } from '../ticket/ticket.ts';
import { runCli } from './cli.ts';
import type { CliEffects, CliTicket } from './cliEffects.ts';
import {
  failed,
  makeEffects,
  makeFact,
  makeSession,
  makeTicket,
  ticketIdOf,
} from './cliHarness.ts';
import type { FakeSession } from './cliHarness.ts';

type Kind = CliTicket['frontMatter']['kind'];
type Status = CliTicket['frontMatter']['status'];

const criteria = [{ id: 'works', check: 'Run it.', expected: 'It works.' }];

const ticketOf = (id: string, kind: Kind, status: Status, parent?: string): CliTicket => {
  const base = makeTicket(id);
  const parentField = parent === undefined ? {} : { parent: ticketIdOf(parent) };

  const planned = kind === 'plan' || kind === 'slice';
  const withCriteria = planned ? { criteria } : {};

  return makeTicket(id, {
    frontMatter: { ...base.frontMatter, kind, status, ...withCriteria, ...parentField },
  });
};

const plan = ticketOf('demo-3467', 'plan', 'canceled');
const slice = ticketOf('demo-4789', 'slice', 'open', 'demo-3467');
const instruction = ticketOf('demo-6789', 'instruction', 'open', 'demo-4789');

const statusFact = (ticket: string, status: Status, at: string): Fact =>
  makeFact({ kind: 'status', ticket, status, at });

const runLs = async (
  fakeSession: FakeSession,
  overrides: Partial<CliEffects> = {},
): Promise<{ tickets: { id: string }[] }> => {
  const { effects } = makeEffects({ session: fakeSession, overrides });
  const output: string[] = [];

  const exitCode = await runCli(['ls', '--json'], effects, {
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
  });

  expect(exitCode).toBe(0);

  return JSON.parse(output.join('')) as { tickets: { id: string }[] };
};

const archivedOf = (fakeSession: FakeSession, path: string): string | undefined => {
  const write = fakeSession.writes.findLast((candidate) => candidate.path === path);
  const parsed = parseTicketFile(write?.text ?? '');

  return parsed.ok ? parsed.value.frontMatter.archived : undefined;
};

it('archives a plan canceled 14 days ago with its slice and instruction in place', async () => {
  const fakeSession = makeSession({
    tickets: [plan, slice, instruction],
    facts: [statusFact('demo-3467', 'canceled', '2026-10-06T12:00:00.000Z')],
  });

  const listed = await runLs(fakeSession);

  expect([plan, slice, instruction].map((ticket) => archivedOf(fakeSession, ticket.path))).toEqual([
    '2026-10-20',
    '2026-10-20',
    '2026-10-20',
  ]);

  expect(fakeSession.writes.every((write) => write.underLock)).toBe(true);
  expect(listed.tickets).toEqual([]);
  expect(fakeSession.lockHeld()).toBe(false);
});

it('does not archive a plan canceled 13 days ago', async () => {
  const fakeSession = makeSession({
    tickets: [plan, slice, instruction],
    facts: [statusFact('demo-3467', 'canceled', '2026-10-07T12:00:00.000Z')],
  });

  const listed = await runLs(fakeSession);

  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
  expect(listed.tickets.map((ticket) => ticket.id)).toHaveLength(3);
});

it('archives a done stand-alone task 14 days after it was done', async () => {
  const task = ticketOf('demo-3467', 'task', 'done');

  const fakeSession = makeSession({
    tickets: [task],
    facts: [statusFact('demo-3467', 'done', '2026-10-06T12:00:00.000Z')],
  });

  const listed = await runLs(fakeSession);

  expect(archivedOf(fakeSession, task.path)).toBe('2026-10-20');
  expect(listed.tickets).toEqual([]);
});

it('archives a stand-alone instruction 14 days after it was accepted', async () => {
  const done = ticketOf('demo-3467', 'instruction', 'open');

  const fakeSession = makeSession({
    tickets: [done],
    facts: [
      makeFact({
        kind: 'log',
        type: 'submitted',
        text: '',
        item: '5ab0000000a1',
        at: '2026-10-06T11:00:00.000Z',
      }),
      makeFact({ kind: 'accept', item: '5ab0000000a1', at: '2026-10-06T12:00:00.000Z' }),
    ],
  });

  await runLs(fakeSession);

  expect(archivedOf(fakeSession, done.path)).toBe('2026-10-20');
});

it('dates a hand edit to canceled with a status fact and archives it 14 days later', async () => {
  const fakeSession = makeSession({ tickets: [plan, slice, instruction] });

  const listed = await runLs(fakeSession);

  expect(fakeSession.appends).toMatchObject([
    {
      machine: 'laptop',
      fact: {
        kind: 'status',
        ticket: 'demo-3467',
        status: 'canceled',
        at: '2026-10-20T12:00:00.000Z',
      },
    },
  ]);

  expect(fakeSession.writes).toEqual([]);
  expect(listed.tickets).toHaveLength(3);

  await runLs(fakeSession, { now: () => new Date('2026-11-03T11:59:59.000Z') });

  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toHaveLength(1);

  const later = await runLs(fakeSession, { now: () => new Date('2026-11-03T12:00:00.000Z') });

  expect(archivedOf(fakeSession, plan.path)).toBe('2026-11-03');
  expect(later.tickets).toEqual([]);
});

it('keeps a ticket whose file has an error out of the sweep', async () => {
  const broken = { ...instruction, error: 'The front matter is invalid.' };

  const fakeSession = makeSession({
    tickets: [plan, slice, broken],
    facts: [statusFact('demo-3467', 'canceled', '2026-10-06T12:00:00.000Z')],
  });

  await runLs(fakeSession);

  expect(fakeSession.writes.map((write) => write.path)).toEqual([plan.path, slice.path]);
});

it('runs the command and leaves the files when the store lock is held', async () => {
  const waitingLocks: string[] = [];

  const fakeSession = makeSession({
    tickets: [plan],
    facts: [statusFact('demo-3467', 'canceled', '2026-10-06T12:00:00.000Z')],
    overrides: {
      tryLockStore: () =>
        Promise.resolve({ ok: false, reason: { kind: 'locked', message: 'The store is locked.' } }),
      lockStore: () => {
        waitingLocks.push('lockStore');

        return Promise.resolve({ ok: false, reason: { kind: 'locked', message: 'Waited.' } });
      },
    },
  });

  const listed = await runLs(fakeSession);

  expect(waitingLocks).toEqual([]);
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
  expect(listed.tickets.map((ticket) => ticket.id)).toEqual(['demo-3467']);
});

it('runs the command and writes the other tickets when one write fails', async () => {
  const fakeSession = makeSession({
    tickets: [plan, slice, instruction],
    facts: [statusFact('demo-3467', 'canceled', '2026-10-06T12:00:00.000Z')],
  });

  const writeTicketFile = fakeSession.session.writeTicketFile;

  fakeSession.session.writeTicketFile = (path, expectedHash, text) =>
    path === slice.path
      ? Promise.resolve({
          ok: false,
          reason: { kind: 'changedOnDisk', message: `${path} changed on disk.` },
        })
      : writeTicketFile(path, expectedHash, text);

  const listed = await runLs(fakeSession);

  expect(listed.tickets.map((ticket) => ticket.id)).toEqual(['demo-4789']);
});

it('runs the command and appends nothing when the machine cannot be resolved', async () => {
  const fakeSession = makeSession({ tickets: [plan] });

  const listed = await runLs(fakeSession, {
    resolveMachine: () => failed('The machine name is invalid.'),
  });

  expect(fakeSession.appends).toEqual([]);
  expect(listed.tickets).toHaveLength(1);
});

it('loads no tickets or facts when the cache says no archive work is possible', async () => {
  const loads: string[] = [];

  const fakeSession = makeSession({
    tickets: [plan],
    facts: [statusFact('demo-3467', 'canceled', '2026-10-06T12:00:00.000Z')],
    overrides: {
      mayHaveArchiveWork: () => false,
      listArchiveFacts: () => {
        loads.push('facts');

        return Promise.resolve({ ok: true, value: [] });
      },
    },
  });

  const listed = await runLs(fakeSession);

  expect(loads).toEqual([]);
  expect(fakeSession.writes).toEqual([]);
  expect(listed.tickets.map((ticket) => ticket.id)).toEqual(['demo-3467']);
});

it('runs the command when the archive facts cannot be read', async () => {
  const fakeSession = makeSession({
    tickets: [plan],
    overrides: { listArchiveFacts: () => failed('The facts are damaged.') },
  });

  const listed = await runLs(fakeSession);

  expect(fakeSession.writes).toEqual([]);
  expect(listed.tickets.map((ticket) => ticket.id)).toEqual(['demo-3467']);
});

it('takes no store lock when nothing is due', async () => {
  const lockAttempts: string[] = [];

  const fakeSession = makeSession({
    tickets: [plan, slice, instruction],
    facts: [statusFact('demo-3467', 'canceled', '2026-10-07T12:00:00.000Z')],
    overrides: {
      tryLockStore: () => {
        lockAttempts.push('tryLockStore');

        return Promise.resolve({ ok: false, reason: { kind: 'locked', message: 'Locked.' } });
      },
    },
  });

  await runLs(fakeSession);

  expect(lockAttempts).toEqual([]);
});

it('writes nothing when the refresh under the lock fails', async () => {
  const fakeSession = makeSession({
    tickets: [plan],
    facts: [statusFact('demo-3467', 'canceled', '2026-10-06T12:00:00.000Z')],
  });

  const refresh = fakeSession.session.refresh;
  let refreshes = 0;

  fakeSession.session.refresh = () => {
    refreshes += 1;

    return refreshes === 1 ? refresh() : failed('The cache failed.');
  };

  const listed = await runLs(fakeSession);

  expect(fakeSession.writes).toEqual([]);
  expect(listed.tickets.map((ticket) => ticket.id)).toEqual(['demo-3467']);
});

it('runs the command when the archive facts cannot be read under the lock', async () => {
  const fakeSession = makeSession({
    tickets: [plan],
    facts: [statusFact('demo-3467', 'canceled', '2026-10-06T12:00:00.000Z')],
  });

  const listArchiveFacts = fakeSession.session.listArchiveFacts;
  let reads = 0;

  fakeSession.session.listArchiveFacts = () => {
    reads += 1;

    return reads === 1 ? listArchiveFacts() : failed('The facts are damaged.');
  };

  await runLs(fakeSession);

  expect(fakeSession.writes).toEqual([]);
});
