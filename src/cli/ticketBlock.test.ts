import { expect, it } from 'bun:test';

import { parseTicketFile } from '../ticket/ticket.ts';
import type { CliTicket } from './cliEffects.ts';
import {
  failureOf,
  makeEffects,
  makeKindTicket,
  makeSession,
  makeTicket,
  successOf,
  ticketIdOf,
} from './cliHarness.ts';
import { ticketBlock, ticketUnblock } from './ticketBlock.ts';

const task = (id: string, fields: Partial<CliTicket['frontMatter']> = {}): CliTicket => {
  const base = makeKindTicket(id, 'task');

  return makeTicket(id, { frontMatter: { ...base.frontMatter, ...fields } });
};

const run = async (command: typeof ticketBlock, args: string[], tickets: CliTicket[]) => {
  const fakeSession = makeSession({ tickets });
  const { effects } = makeEffects({ session: fakeSession });
  const result = await command({ args, json: true, effects, session: fakeSession.session });

  return { fakeSession, result };
};

it('refuses to block a ticket by one that it blocks, names both, and writes nothing', async () => {
  const tickets = [task('demo-3467', { blockedBy: [ticketIdOf('demo-3468')] }), task('demo-3468')];
  const { fakeSession, result } = await run(ticketBlock, ['demo-3468', 'demo-3467'], tickets);
  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('demo-3467');
  expect(failure.message).toContain('demo-3468');
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.lockHeld()).toBe(false);
});

it('adds the blocker under the lock and shows the ticket', async () => {
  const tickets = [
    task('demo-3467', { blockedBy: [ticketIdOf('demo-3469')] }),
    task('demo-3468'),
    task('demo-3469'),
  ];

  const { fakeSession, result } = await run(ticketBlock, ['demo-3467', 'demo-3468'], tickets);
  const [write] = fakeSession.writes;
  const written = parseTicketFile(write?.text ?? '');

  expect(successOf(result).json).toMatchObject({
    id: 'demo-3467',
    blockedBy: ['demo-3469', 'demo-3468'],
  });

  expect(write?.expectedHash).toBe('hash-demo-3467');
  expect(write?.underLock).toBe(true);

  expect(written.ok && written.value.frontMatter.blockedBy).toEqual([
    ticketIdOf('demo-3469'),
    ticketIdOf('demo-3468'),
  ]);

  expect(written.ok && written.value.body).toBe('A body\n');
  expect(fakeSession.appends).toEqual([]);
});

it('writes nothing when the blocker is already there', async () => {
  const tickets = [task('demo-3467', { blockedBy: [ticketIdOf('demo-3468')] }), task('demo-3468')];
  const { fakeSession, result } = await run(ticketBlock, ['demo-3467', 'demo-3468'], tickets);

  expect(successOf(result).json).toMatchObject({ id: 'demo-3467', blockedBy: ['demo-3468'] });
  expect(fakeSession.writes).toEqual([]);
});

it('refuses a blocker that does not exist', async () => {
  const { fakeSession, result } = await run(
    ticketBlock,
    ['demo-3467', 'demo-3468'],
    [task('demo-3467')],
  );

  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('demo-3468');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses a blocker whose file has an error', async () => {
  const broken = makeTicket('demo-3468', { ...task('demo-3468'), error: 'bad front matter' });

  const { fakeSession, result } = await run(
    ticketBlock,
    ['demo-3467', 'demo-3468'],
    [task('demo-3467'), broken],
  );

  expect(failureOf(result).message).toContain('file error');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses a blocker that is not a ticket ID', async () => {
  const { fakeSession, result } = await run(
    ticketBlock,
    ['demo-3467', 'nope'],
    [task('demo-3467')],
  );

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses to block a ticket by itself', async () => {
  const { fakeSession, result } = await run(
    ticketBlock,
    ['demo-3467', 'demo-3467'],
    [task('demo-3467')],
  );

  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('demo-3467');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses to change a ticket whose file has an error', async () => {
  const broken = makeTicket('demo-3467', { ...task('demo-3467'), error: 'bad front matter' });

  const { fakeSession, result } = await run(
    ticketBlock,
    ['demo-3467', 'demo-3468'],
    [broken, task('demo-3468')],
  );

  expect(failureOf(result).code).toBe('parseError');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses a blocker that would close a cycle through an archived ticket', async () => {
  const archived = task('demo-3468', {
    blockedBy: [ticketIdOf('demo-3467')],
    archived: '2026-10-01',
    status: 'done',
  });

  const { fakeSession, result } = await run(
    ticketBlock,
    ['demo-3467', 'demo-3468'],
    [task('demo-3467'), archived],
  );

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('reports a ticket that changed on disk during the write', async () => {
  const fakeSession = makeSession({ tickets: [task('demo-3467'), task('demo-3468')] });
  const { effects } = makeEffects({ session: fakeSession });

  fakeSession.session.writeTicketFile = (path) =>
    Promise.resolve({
      ok: false,
      reason: { kind: 'changedOnDisk', message: `${path} changed on disk.` },
    });

  const result = await ticketBlock({
    args: ['demo-3467', 'demo-3468'],
    json: true,
    effects,
    session: fakeSession.session,
  });

  expect(failureOf(result).code).toBe('changedOnDisk');
});

it('refuses a missing or extra argument', async () => {
  const tickets = [task('demo-3467'), task('demo-3468')];
  const missing = await run(ticketBlock, ['demo-3467'], tickets);
  const extra = await run(ticketUnblock, ['demo-3467', 'demo-3468', 'demo-3469'], tickets);

  const unknownFlag = await run(ticketBlock, ['demo-3467', 'demo-3468', '--hash', 'x'], tickets);

  expect(failureOf(missing.result).code).toBe('invalidArguments');
  expect(failureOf(extra.result).code).toBe('invalidArguments');
  expect(failureOf(unknownFlag.result).code).toBe('invalidArguments');

  const writes = [missing, extra, unknownFlag].flatMap((ran) => ran.fakeSession.writes);

  expect(writes).toEqual([]);
});

it('removes the blocker and shows the ticket', async () => {
  const blockedBy = [ticketIdOf('demo-3468'), ticketIdOf('demo-3469')];
  const tickets = [task('demo-3467', { blockedBy }), task('demo-3468'), task('demo-3469')];
  const { fakeSession, result } = await run(ticketUnblock, ['demo-3467', 'demo-3468'], tickets);
  const [write] = fakeSession.writes;
  const written = parseTicketFile(write?.text ?? '');

  expect(successOf(result).json).toMatchObject({ id: 'demo-3467', blockedBy: ['demo-3469'] });
  expect(write?.underLock).toBe(true);
  expect(written.ok && written.value.frontMatter.blockedBy).toEqual([ticketIdOf('demo-3469')]);
});

it('removes a blocker whose ticket no longer exists', async () => {
  const tickets = [task('demo-3467', { blockedBy: [ticketIdOf('demo-3468')] })];
  const { result } = await run(ticketUnblock, ['demo-3467', 'demo-3468'], tickets);

  expect(successOf(result).json).toMatchObject({ blockedBy: [] });
});

it('writes nothing when the blocker to remove is not there', async () => {
  const tickets = [task('demo-3467'), task('demo-3468')];
  const { fakeSession, result } = await run(ticketUnblock, ['demo-3467', 'demo-3468'], tickets);

  expect(successOf(result).json).toMatchObject({ id: 'demo-3467', blockedBy: [] });
  expect(fakeSession.writes).toEqual([]);
});
