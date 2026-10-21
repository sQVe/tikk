import { expect, it } from 'bun:test';

import { parseTicketFile } from '../ticket/ticket.ts';
import {
  failed,
  failureOf,
  makeEffects,
  makeKindTicket,
  makeSession,
  successOf,
  ticketIdOf,
} from './cliHarness.ts';
import type { EffectsOptions, SessionOptions } from './cliHarness.ts';
import { ticketClose } from './ticketClose.ts';

const issue = makeKindTicket('demo-3467', 'issue');

const close = async (
  args: string[],
  sessionOptions: SessionOptions = {},
  effectsOptions: EffectsOptions = {},
) => {
  const fakeSession = makeSession({ tickets: [issue], ...sessionOptions });
  const { effects } = makeEffects({ session: fakeSession, ...effectsOptions });
  const result = await ticketClose({ args, json: true, effects, session: fakeSession.session });

  return { fakeSession, result };
};

it('closes an issue in its file and appends one status fact', async () => {
  const { fakeSession, result } = await close(['demo-3467']);
  const [write] = fakeSession.writes;
  const written = parseTicketFile(write?.text ?? '');

  successOf(result);
  expect(write?.path).toBe(issue.path);
  expect(write?.expectedHash).toBe(issue.hash);
  expect(write?.underLock).toBe(true);
  expect(written.ok && written.value.frontMatter.status).toBe('closed');
  expect(fakeSession.appends).toHaveLength(1);

  expect(fakeSession.appends[0]).toMatchObject({
    machine: 'laptop',
    fact: {
      kind: 'status',
      ticket: 'demo-3467',
      status: 'closed',
      at: '2026-10-20T12:00:00.000Z',
    },
  });

  expect(fakeSession.lockHeld()).toBe(false);
});

it('returns an already closed issue unchanged and appends nothing', async () => {
  const closed = makeKindTicket('demo-3467', 'issue', 'closed');
  const { fakeSession, result } = await close(['demo-3467'], { tickets: [closed] });

  expect(successOf(result).json).toMatchObject({ status: 'closed' });
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
});

it('refuses to close a canceled issue and changes nothing', async () => {
  const canceled = makeKindTicket('demo-3467', 'issue', 'canceled');
  const { fakeSession, result } = await close(['demo-3467'], { tickets: [canceled] });

  expect(failureOf(result).code).toBe('conflict');
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
});

it('refuses to close a slice and changes nothing', async () => {
  const slice = makeKindTicket('demo-3467', 'slice');
  const { fakeSession, result } = await close(['demo-3467'], { tickets: [slice] });

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
});

it('refuses to close a task and changes nothing', async () => {
  const task = makeKindTicket('demo-3467', 'task');
  const { fakeSession, result } = await close(['demo-3467'], { tickets: [task] });

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses to close an issue with a parent and changes nothing', async () => {
  const plan = makeKindTicket('demo-4789', 'plan');

  const child = {
    ...issue,
    frontMatter: { ...issue.frontMatter, parent: ticketIdOf('demo-4789') },
  };

  const { fakeSession, result } = await close(['demo-3467'], { tickets: [child, plan] });
  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('demo-4789');
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
});

it('refuses to close an issue blocked by a ticket that does not exist and changes nothing', async () => {
  const blocked = {
    ...issue,
    frontMatter: { ...issue.frontMatter, blockedBy: [ticketIdOf('demo-6789')] },
  };

  const { fakeSession, result } = await close(['demo-3467'], { tickets: [blocked] });
  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('demo-6789');
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
});

it('refuses an issue whose file has an error', async () => {
  const broken = { ...issue, error: 'Duplicate ID.' };
  const { fakeSession, result } = await close(['demo-3467'], { tickets: [broken] });

  expect(failureOf(result).code).toBe('parseError');
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
});

it('reports that the file was written when the fact cannot be appended', async () => {
  const { fakeSession, result } = await close(['demo-3467'], {
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

it('refuses without writing when the machine cannot be resolved', async () => {
  const { fakeSession, result } = await close(
    ['demo-3467'],
    {},
    { overrides: { resolveMachine: () => failed('No machine.') } },
  );

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('requires exactly one ID', async () => {
  const { result } = await close([]);

  expect(failureOf(result).code).toBe('invalidArguments');
});
