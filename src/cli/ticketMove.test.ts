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
import { ticketMove } from './ticketMove.ts';

const ticketOf = (
  id: string,
  kind: CliTicket['frontMatter']['kind'],
  fields: Partial<CliTicket['frontMatter']> = {},
): CliTicket => {
  const base = makeKindTicket(id, kind);

  return makeTicket(id, { frontMatter: { ...base.frontMatter, ...fields } });
};

const run = async (args: string[], tickets: CliTicket[]) => {
  const fakeSession = makeSession({ tickets });
  const { effects } = makeEffects({ session: fakeSession });
  const result = await ticketMove({ args, json: true, effects, session: fakeSession.session });

  return { fakeSession, result };
};

const criteria = [{ id: 'a', check: 'check a', expected: 'a holds' }];

it('refuses to move an instruction under a plan and writes nothing', async () => {
  const tickets = [ticketOf('demo-3467', 'instruction'), ticketOf('demo-3468', 'plan')];
  const { fakeSession, result } = await run(['demo-3467', '--parent', 'demo-3468'], tickets);

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.lockHeld()).toBe(false);
});

it('moves a task under a new parent under the lock, drops new, and shows it', async () => {
  const tickets = [ticketOf('demo-3467', 'task', { new: true }), ticketOf('demo-3468', 'slice')];
  const { fakeSession, result } = await run(['demo-3467', '--parent', 'demo-3468'], tickets);
  const [write] = fakeSession.writes;
  const written = parseTicketFile(write?.text ?? '');

  expect(successOf(result).json).toMatchObject({ id: 'demo-3467', parent: 'demo-3468' });
  expect(write?.expectedHash).toBe('hash-demo-3467');
  expect(write?.underLock).toBe(true);
  expect(written.ok && written.value.frontMatter.parent).toBe(ticketIdOf('demo-3468'));
  expect(written.ok && written.value.frontMatter.new).toBeUndefined();
  expect(written.ok && written.value.body).toBe('A body\n');
});

it('makes a ticket loose with --no-parent and keeps its new state', async () => {
  const tickets = [
    ticketOf('demo-3467', 'task', { new: true, parent: ticketIdOf('demo-3468') }),
    ticketOf('demo-3468', 'slice'),
  ];

  const { fakeSession, result } = await run(['demo-3467', '--no-parent'], tickets);
  const [write] = fakeSession.writes;
  const written = parseTicketFile(write?.text ?? '');

  expect(successOf(result).json).toMatchObject({ id: 'demo-3467' });
  expect(written.ok && written.value.frontMatter.parent).toBeUndefined();
  expect(written.ok && written.value.frontMatter.new).toBe(true);
});

it('writes nothing when the ticket already has the parent', async () => {
  const tickets = [
    ticketOf('demo-3467', 'task', { new: true, parent: ticketIdOf('demo-3468') }),
    ticketOf('demo-3468', 'slice'),
  ];

  const { fakeSession, result } = await run(['demo-3467', '--parent', 'demo-3468'], tickets);

  expect(successOf(result).json).toMatchObject({ id: 'demo-3467', parent: 'demo-3468' });
  expect(fakeSession.writes).toEqual([]);
});

it('refuses a parent that does not exist and writes nothing', async () => {
  const { fakeSession, result } = await run(
    ['demo-3467', '--parent', 'demo-3468'],
    [ticketOf('demo-3467', 'task')],
  );

  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('demo-3468');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses to move a task under a slice it blocks, names the cycle, and writes nothing', async () => {
  const tickets = [
    ticketOf('demo-3467', 'task'),
    ticketOf('demo-3468', 'slice', { blockedBy: [ticketIdOf('demo-3467')] }),
  ];

  const { fakeSession, result } = await run(['demo-3467', '--parent', 'demo-3468'], tickets);
  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('demo-3467, demo-3468, demo-3467');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses to move an instruction whose covers the new slice lacks and writes nothing', async () => {
  const tickets = [
    ticketOf('demo-3467', 'instruction', {
      parent: ticketIdOf('demo-3468'),
      covers: ['a', 'b'],
    }),
    ticketOf('demo-3468', 'slice', { criteria }),
    ticketOf('demo-3469', 'slice', { criteria }),
  ];

  const { fakeSession, result } = await run(['demo-3467', '--parent', 'demo-3469'], tickets);
  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('demo-3469');
  expect(failure.message).toContain('b');
  expect(fakeSession.writes).toEqual([]);
});

it('moves an instruction whose covers the new slice has', async () => {
  const tickets = [
    ticketOf('demo-3467', 'instruction', { parent: ticketIdOf('demo-3468'), covers: ['a'] }),
    ticketOf('demo-3468', 'slice', { criteria }),
    ticketOf('demo-3469', 'slice', { criteria }),
  ];

  const { fakeSession, result } = await run(['demo-3467', '--parent', 'demo-3469'], tickets);

  expect(successOf(result).json).toMatchObject({ id: 'demo-3467', parent: 'demo-3469' });
  expect(fakeSession.writes).toHaveLength(1);
});

it('refuses --no-parent on a ticket with covers and writes nothing', async () => {
  const tickets = [
    ticketOf('demo-3467', 'slice', { parent: ticketIdOf('demo-3468'), covers: ['a'] }),
    ticketOf('demo-3468', 'plan', { criteria }),
  ];

  const { fakeSession, result } = await run(['demo-3467', '--no-parent'], tickets);

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

for (const args of [
  [],
  ['demo-3467'],
  ['demo-3467', 'demo-3468', '--parent', 'demo-3468'],
  ['demo-3467', '--parent', 'demo-3468', '--hash', 'x'],
  ['demo-3467', '--parent', 'demo-3468', '--no-parent'],
  ['demo-3467', '--parent', 'nope'],
]) {
  it(`refuses tikk move ${args.join(' ')} and writes nothing`, async () => {
    const tickets = [ticketOf('demo-3467', 'task'), ticketOf('demo-3468', 'slice')];
    const { fakeSession, result } = await run(args, tickets);

    expect(failureOf(result).code).toBe('invalidArguments');
    expect(fakeSession.writes).toEqual([]);
  });
}

it('reports a ticket that changed on disk during the write', async () => {
  const fakeSession = makeSession({
    tickets: [ticketOf('demo-3467', 'task'), ticketOf('demo-3468', 'slice')],
  });

  const { effects } = makeEffects({ session: fakeSession });

  fakeSession.session.writeTicketFile = (path) =>
    Promise.resolve({
      ok: false,
      reason: { kind: 'changedOnDisk', message: `${path} changed on disk.` },
    });

  const result = await ticketMove({
    args: ['demo-3467', '--parent', 'demo-3468'],
    json: true,
    effects,
    session: fakeSession.session,
  });

  expect(failureOf(result).code).toBe('changedOnDisk');
});
