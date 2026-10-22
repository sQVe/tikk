import { expect, it } from 'bun:test';

import { parseTicketFile } from '../ticket/ticket.ts';
import { runCli } from './cli.ts';
import type { CliTicket } from './cliEffects.ts';
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
type WriteFailure = 'changedOnDisk' | 'failed';

const criteria = [{ id: 'works', check: 'Run it.', expected: 'It works.' }];

const ticketOf = (
  id: string,
  kind: Kind,
  status: Status,
  fields: Partial<CliTicket['frontMatter']> = {},
): CliTicket => {
  const base = makeTicket(id);

  const planned = kind === 'plan' || kind === 'slice';
  const withCriteria = planned ? { criteria } : {};

  return makeTicket(id, {
    frontMatter: { ...base.frontMatter, kind, status, ...withCriteria, ...fields },
  });
};

const canceledLongAgo = makeFact({
  kind: 'status',
  ticket: 'demo-3467',
  status: 'canceled',
  at: '2026-09-01T12:00:00.000Z',
});

const archivedPlan = ticketOf('demo-3467', 'plan', 'canceled', { archived: '2026-09-15' });

const archivedSliceOf = (id: string): CliTicket =>
  ticketOf(id, 'slice', 'open', { archived: '2026-09-15', parent: ticketIdOf('demo-3467') });

const firstSlice = archivedSliceOf('demo-4789');
const archivedSlices = [firstSlice, archivedSliceOf('demo-6789')];

const run = async (
  fakeSession: FakeSession,
  argv: string[],
): Promise<{ exitCode: number; json: unknown }> => {
  const { effects } = makeEffects({ session: fakeSession });
  const output: string[] = [];

  const exitCode = await runCli([...argv, '--json'], effects, {
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
  });

  return { exitCode, json: JSON.parse(output.join('')) };
};

const listedIds = async (fakeSession: FakeSession): Promise<string[]> => {
  const listed = await run(fakeSession, ['ls']);
  const { tickets } = listed.json as { tickets: { id: string }[] };

  return tickets.map((ticket) => ticket.id);
};

const archivedIn = (text: string | undefined): string | undefined => {
  const parsed = parseTicketFile(text ?? '');

  return parsed.ok ? parsed.value.frontMatter.archived : undefined;
};

it('unarchives a plan and its slices and appends an unarchive fact for each', async () => {
  const fakeSession = makeSession({
    tickets: [archivedPlan, ...archivedSlices],
    facts: [canceledLongAgo],
  });

  const result = await run(fakeSession, ['unarchive', 'demo-3467']);

  expect(result.exitCode).toBe(0);

  expect(fakeSession.writes.map((write) => [write.path, archivedIn(write.text)])).toEqual([
    [archivedPlan.path, undefined],
    ...archivedSlices.map((slice) => [slice.path, undefined]),
  ]);

  expect(fakeSession.writes.every((write) => write.underLock)).toBe(true);

  expect(fakeSession.appends.map((append) => append.fact)).toMatchObject([
    { kind: 'unarchive', ticket: 'demo-3467', at: '2026-10-20T12:00:00.000Z' },
    { kind: 'unarchive', ticket: 'demo-4789' },
    { kind: 'unarchive', ticket: 'demo-6789' },
  ]);

  expect(await listedIds(fakeSession)).toEqual(['demo-3467', 'demo-4789', 'demo-6789']);
  expect(fakeSession.writes).toHaveLength(3);
  expect(fakeSession.lockHeld()).toBe(false);
});

it('unarchives a slice of an archived plan, and the next command keeps it out of the archive', async () => {
  const fakeSession = makeSession({
    tickets: [archivedPlan, ...archivedSlices],
    facts: [canceledLongAgo],
  });

  await run(fakeSession, ['unarchive', 'demo-4789']);

  expect(fakeSession.writes.map((write) => write.path)).toEqual([firstSlice.path]);
  expect(await listedIds(fakeSession)).toEqual(['demo-4789']);
  expect(fakeSession.writes).toHaveLength(1);
});

it('archives a ticket and its descendants with today and skips archived ones', async () => {
  const plan = ticketOf('demo-3467', 'plan', 'open');
  const slice = ticketOf('demo-4789', 'slice', 'open', { parent: ticketIdOf('demo-3467') });

  const archivedTask = ticketOf('demo-6789', 'task', 'open', {
    parent: ticketIdOf('demo-4789'),
    archived: '2026-10-01',
  });

  const fakeSession = makeSession({ tickets: [plan, slice, archivedTask] });
  const result = await run(fakeSession, ['archive', 'demo-3467']);

  expect(result.exitCode).toBe(0);

  expect(fakeSession.writes.map((write) => [write.path, archivedIn(write.text)])).toEqual([
    [plan.path, '2026-10-20'],
    [slice.path, '2026-10-20'],
  ]);

  expect(fakeSession.appends).toEqual([]);
  expect(await listedIds(fakeSession)).toEqual([]);
});

it('refuses to archive a tree with a broken file and writes nothing', async () => {
  const plan = ticketOf('demo-3467', 'plan', 'open');

  const broken = {
    ...ticketOf('demo-4789', 'slice', 'open', { parent: ticketIdOf('demo-3467') }),
    error: 'The front matter is invalid.',
  };

  const fakeSession = makeSession({ tickets: [plan, broken] });
  const result = await run(fakeSession, ['archive', 'demo-3467']);

  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({ error: { code: 'parseError' } });
  expect(fakeSession.writes).toEqual([]);
});

it('refuses an archive without an ID', async () => {
  const fakeSession = makeSession({ tickets: [archivedPlan] });
  const result = await run(fakeSession, ['archive']);

  expect(result.json).toMatchObject({ error: { code: 'invalidArguments' } });
  expect(fakeSession.writes).toEqual([]);
});

// Fails the write of the first slice and records every write attempted.
const failingSliceWrites = (fakeSession: FakeSession, kind: WriteFailure): string[] => {
  const attempted: string[] = [];
  const writeTicketFile = fakeSession.session.writeTicketFile;

  fakeSession.session.writeTicketFile = (path, expectedHash, text) => {
    attempted.push(path);

    if (path === firstSlice.path) {
      return Promise.resolve({ ok: false, reason: { kind, message: `${path} was not written.` } });
    }

    return writeTicketFile(path, expectedHash, text);
  };

  return attempted;
};

const failureCases: [WriteFailure, string][] = [
  ['changedOnDisk', 'changedOnDisk'],
  ['failed', 'storeError'],
];

for (const [kind, code] of failureCases) {
  it(`stops unarchive at a ${kind} write with code ${code} and appends no fact for it`, async () => {
    const fakeSession = makeSession({
      tickets: [archivedPlan, ...archivedSlices],
      facts: [canceledLongAgo],
    });

    const attempted = failingSliceWrites(fakeSession, kind);
    const result = await run(fakeSession, ['unarchive', 'demo-3467']);

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ error: { code } });
    expect(attempted).toEqual([archivedPlan.path, firstSlice.path]);
    expect(fakeSession.appends.map((append) => String(append.fact.ticket))).toEqual(['demo-3467']);
    expect(fakeSession.lockHeld()).toBe(false);
  });

  it(`stops archive at a ${kind} write with code ${code}`, async () => {
    const livePlan = ticketOf('demo-3467', 'plan', 'open');

    const liveSlices = ['demo-4789', 'demo-6789'].map((id) =>
      ticketOf(id, 'slice', 'open', { parent: ticketIdOf('demo-3467') }),
    );

    const fakeSession = makeSession({ tickets: [livePlan, ...liveSlices] });
    const attempted = failingSliceWrites(fakeSession, kind);
    const result = await run(fakeSession, ['archive', 'demo-3467']);

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ error: { code } });
    expect(attempted).toEqual([livePlan.path, firstSlice.path]);
    expect(fakeSession.appends).toEqual([]);
  });
}

it('reports a storeError when an unarchive fact cannot be appended', async () => {
  const fakeSession = makeSession({
    tickets: [archivedPlan],
    facts: [canceledLongAgo],
    overrides: {
      appendFact: () =>
        Promise.resolve({ ok: false, reason: { kind: 'failed', message: 'Disk full.' } }),
    },
  });

  const result = await run(fakeSession, ['unarchive', 'demo-3467']);

  expect(result.json).toMatchObject({ error: { code: 'storeError' } });
});

it('refuses an unarchive without a machine name and writes nothing', async () => {
  const fakeSession = makeSession({ tickets: [archivedPlan], facts: [canceledLongAgo] });

  const { effects } = makeEffects({
    session: fakeSession,
    overrides: { resolveMachine: () => failed('No machine.') },
  });

  const output: string[] = [];

  await runCli(['unarchive', 'demo-3467', '--json'], effects, {
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
  });

  expect(JSON.parse(output.join(''))).toMatchObject({ error: { code: 'invalidArguments' } });
  expect(fakeSession.writes).toEqual([]);
});

const refusedArchiveArguments: string[][] = [
  ['archive', 'demo-3467', 'demo-4789'],
  ['archive', 'demo-3467', '--bogus'],
];

for (const argv of refusedArchiveArguments) {
  it(`refuses ${argv.join(' ')} and writes nothing`, async () => {
    const fakeSession = makeSession({ tickets: [ticketOf('demo-3467', 'plan', 'open')] });
    const result = await run(fakeSession, argv);

    expect(result.json).toMatchObject({ error: { code: 'invalidArguments' } });
    expect(fakeSession.writes).toEqual([]);
  });
}
