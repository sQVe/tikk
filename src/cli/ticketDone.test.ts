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
import { ticketDone } from './ticketDone.ts';

const task = makeKindTicket('demo-3467', 'task');

const markDone = async (
  args: string[],
  sessionOptions: SessionOptions = {},
  effectsOptions: EffectsOptions = {},
) => {
  const fakeSession = makeSession({ tickets: [task], ...sessionOptions });
  const { effects } = makeEffects({ session: fakeSession, ...effectsOptions });
  const result = await ticketDone({ args, json: true, effects, session: fakeSession.session });

  return { fakeSession, result };
};

it('closes a task in its file and appends one status fact', async () => {
  const { fakeSession, result } = await markDone(['demo-3467']);
  const [write] = fakeSession.writes;
  const written = parseTicketFile(write?.text ?? '');

  successOf(result);
  expect(write?.path).toBe(task.path);
  expect(write?.expectedHash).toBe(task.hash);
  expect(write?.underLock).toBe(true);
  expect(written.ok && written.value.frontMatter.status).toBe('done');
  expect(fakeSession.appends).toHaveLength(1);

  expect(fakeSession.appends[0]).toMatchObject({
    machine: 'laptop',
    fact: {
      kind: 'status',
      ticket: 'demo-3467',
      status: 'done',
      at: '2026-10-20T12:00:00.000Z',
    },
  });

  expect(fakeSession.lockHeld()).toBe(false);
});

it('returns an already done task unchanged and appends nothing', async () => {
  const done = makeKindTicket('demo-3467', 'task', 'done');
  const { fakeSession, result } = await markDone(['demo-3467'], { tickets: [done] });

  expect(successOf(result).json).toMatchObject({ status: 'done' });
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
});

it('refuses to done a canceled task and changes nothing', async () => {
  const canceled = makeKindTicket('demo-3467', 'task', 'canceled');
  const { fakeSession, result } = await markDone(['demo-3467'], { tickets: [canceled] });

  expect(failureOf(result).code).toBe('conflict');
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
});

it('refuses to done a slice and changes nothing', async () => {
  const slice = makeKindTicket('demo-3467', 'slice');
  const { fakeSession, result } = await markDone(['demo-3467'], { tickets: [slice] });

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
});

it('refuses to done an instruction and changes nothing', async () => {
  const instruction = makeKindTicket('demo-3467', 'instruction');
  const { fakeSession, result } = await markDone(['demo-3467'], { tickets: [instruction] });

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('marks a task under a plan done', async () => {
  const plan = makeKindTicket('demo-4789', 'plan');

  const child = {
    ...task,
    frontMatter: { ...task.frontMatter, parent: ticketIdOf('demo-4789') },
  };

  const { fakeSession, result } = await markDone(['demo-3467'], { tickets: [child, plan] });

  successOf(result);
  expect(fakeSession.appends).toHaveLength(1);
});

it('marks a task under a slice done', async () => {
  const slice = makeKindTicket('demo-4789', 'slice');

  const child = {
    ...task,
    frontMatter: { ...task.frontMatter, parent: ticketIdOf('demo-4789') },
  };

  const { fakeSession, result } = await markDone(['demo-3467'], { tickets: [child, slice] });

  successOf(result);
  expect(fakeSession.appends).toHaveLength(1);
});

it('drops new when the task is marked done', async () => {
  const fresh = { ...task, frontMatter: { ...task.frontMatter, new: true } };
  const { fakeSession, result } = await markDone(['demo-3467'], { tickets: [fresh] });
  const written = parseTicketFile(fakeSession.writes[0]?.text ?? '');

  successOf(result);
  expect(written.ok && written.value.frontMatter.status).toBe('done');
  expect(written.ok && 'new' in written.value.frontMatter).toBe(false);
});

it('refuses to done a task blocked by a ticket that does not exist and changes nothing', async () => {
  const blocked = {
    ...task,
    frontMatter: { ...task.frontMatter, blockedBy: [ticketIdOf('demo-6789')] },
  };

  const { fakeSession, result } = await markDone(['demo-3467'], { tickets: [blocked] });
  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('demo-6789');
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
});

const blockedByBroken = (): ReturnType<typeof makeKindTicket>[] => {
  const blocker = { ...makeKindTicket('demo-6789', 'task'), error: 'Broken.' };

  const blocked = {
    ...task,
    frontMatter: { ...task.frontMatter, blockedBy: [ticketIdOf('demo-6789')] },
  };

  return [blocked, blocker];
};

it('refuses to done a task blocked by a ticket whose file has an error', async () => {
  const { fakeSession, result } = await markDone(['demo-3467'], { tickets: blockedByBroken() });
  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('demo-6789');
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
});

it('marks done past a blocker whose file has an error with --force --reason', async () => {
  const { fakeSession, result } = await markDone(['demo-3467', '--force', '--reason', 'Known'], {
    tickets: blockedByBroken(),
  });

  successOf(result);
  expect(fakeSession.appends).toHaveLength(1);
});

it('refuses a task whose file has an error', async () => {
  const broken = { ...task, error: 'Duplicate ID.' };
  const { fakeSession, result } = await markDone(['demo-3467'], { tickets: [broken] });

  expect(failureOf(result).code).toBe('parseError');
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
});

it('reports that the file was written when the fact cannot be appended', async () => {
  const { fakeSession, result } = await markDone(['demo-3467'], {
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
  const { fakeSession, result } = await markDone(
    ['demo-3467'],
    {},
    { overrides: { resolveMachine: () => failed('No machine.') } },
  );

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('requires exactly one ID', async () => {
  const { result } = await markDone([]);

  expect(failureOf(result).code).toBe('invalidArguments');
});

it('shows the done task after it marks it done', async () => {
  const { result } = await markDone(['demo-3467']);

  expect(successOf(result).json).toMatchObject({ id: 'demo-3467', status: 'done' });
});

const refusedCloseArguments: string[][] = [
  ['demo-3467', 'demo-3468'],
  ['demo-3467', '--bogus'],
];

for (const args of refusedCloseArguments) {
  it(`refuses done ${args.join(' ')} and writes nothing`, async () => {
    const { fakeSession, result } = await markDone(args);

    expect(failureOf(result).code).toBe('invalidArguments');
    expect(fakeSession.writes).toEqual([]);
  });
}

it('returns notFound for an unknown task', async () => {
  const { result } = await markDone(['demo-3468']);

  expect(failureOf(result).code).toBe('notFound');
});

it('reports a storeError when the refresh under the lock fails', async () => {
  const { fakeSession, result } = await markDone(['demo-3467'], {
    overrides: { refresh: () => failed('The cache failed.') },
  });

  expect(failureOf(result).code).toBe('storeError');
  expect(fakeSession.writes).toEqual([]);
});

it('marks done past a failed tree check with --force --reason and records the reason', async () => {
  const blocked = {
    ...task,
    frontMatter: { ...task.frontMatter, blockedBy: [ticketIdOf('demo-6789')] },
  };

  const { fakeSession, result } = await markDone(
    ['demo-3467', '--force', '--reason', 'Blocker deleted'],
    { tickets: [blocked] },
  );

  successOf(result);
  expect(fakeSession.appends).toHaveLength(1);

  expect(fakeSession.appends[0]?.fact).toMatchObject({
    kind: 'status',
    status: 'done',
    forced: 'Blocker deleted',
  });
});

it('refuses --force without --reason and changes nothing', async () => {
  const { fakeSession, result } = await markDone(['demo-3467', '--force']);

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
});

it('refuses --reason without --force and changes nothing', async () => {
  const { fakeSession, result } = await markDone(['demo-3467', '--reason', 'Because']);

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
});
