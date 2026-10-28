import { expect, it } from 'bun:test';

import {
  makeEffects,
  makeFact,
  makeKindTicket,
  makeSession,
  makeTicket,
  ticketIdOf,
} from './cliHarness.ts';
import { openNeedsSession } from './needsSession.ts';
import type { NeedsSession } from './needsSession.ts';
import { ticketShow } from './ticketShow.ts';

const openWith = async (...args: Parameters<typeof makeSession>): Promise<NeedsSession> => {
  const { effects } = makeEffects({ session: makeSession(...args) });
  const opened = await openNeedsSession(effects);

  if (!opened.ok) {
    throw new Error(opened.reason.message);
  }

  return opened.value;
};

const childOf = (id: string, parent: string, archived?: string) => {
  const base = makeTicket(id).frontMatter;

  return makeTicket(id, {
    frontMatter: {
      ...base,
      title: `Child ${id}`,
      parent: ticketIdOf(parent),
      ...(archived === undefined ? {} : { archived }),
    },
  });
};

it('loads a slice with its body, derived state, PR, and unarchived children', async () => {
  const slice = makeKindTicket('demo-3469', 'slice');

  const merged = makeFact({
    ticket: 'demo-3469',
    kind: 'pr',
    repository: 'sqve/tikk',
    number: 7,
    state: 'merged',
    base: 'main',
    head: 'aaa',
    trunk: 'main',
    inTrunk: true,
  });

  const needs = await openWith({
    tickets: [
      slice,
      childOf('demo-3478', 'demo-3469'),
      childOf('demo-3479', 'demo-3469', '2026-01-02'),
    ],
    facts: [merged],
  });

  const loaded = await needs.loadDetail('demo-3469');

  expect(loaded).toMatchObject({
    ok: true,
    value: {
      ticket: { id: 'demo-3469', kind: 'slice' },
      body: 'A body\n',
      state: 'mergedUnverified',
      pr: { repository: 'sqve/tikk', number: 7 },
      children: [{ id: 'demo-3478', kind: 'instruction', title: 'Child demo-3478' }],
    },
  });

  await needs.close();
});

it('loads the derived state of an instruction, as show sees it', async () => {
  const claim = makeFact({ kind: 'claim', holder: 'agent', leaseEnd: '2026-10-20T13:00:00.000Z' });
  const needs = await openWith({ tickets: [makeTicket('demo-3467')], facts: [claim] });

  expect(await needs.loadDetail('demo-3467')).toMatchObject({
    ok: true,
    value: { state: 'active', pr: null, children: [] },
  });

  await needs.close();
});

it('returns notFound for a ticket that does not exist', async () => {
  const needs = await openWith({ tickets: [] });

  expect(await needs.loadDetail('demo-3400')).toMatchObject({
    ok: false,
    reason: { code: 'notFound' },
  });

  await needs.close();
});

it('returns the same children from show --json and from loadDetail', async () => {
  const tickets = [
    makeKindTicket('demo-3469', 'slice'),
    childOf('demo-3478', 'demo-3469'),
    childOf('demo-3479', 'demo-3469', '2026-01-02'),
  ];

  const fakeSession = makeSession({ tickets });
  const { effects } = makeEffects({ session: fakeSession });
  const { session } = fakeSession;
  const shown = await ticketShow({ args: ['demo-3469'], json: true, effects, session });
  const needs = await openWith({ tickets });
  const loaded = await needs.loadDetail('demo-3469');

  await needs.close();

  const loadedChildren = loaded.ok ? loaded.value.children : undefined;

  expect(loadedChildren).toEqual([
    { id: ticketIdOf('demo-3478'), kind: 'instruction', title: 'Child demo-3478' },
  ]);

  expect(shown).toMatchObject({ ok: true, value: { json: { children: loadedChildren } } });
});
