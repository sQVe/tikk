import { expect, it } from 'bun:test';

import { failureOf, makeEffects, makeKindTicket, makeSession, successOf } from './cliHarness.ts';
import type { SessionOptions } from './cliHarness.ts';
import { ticketWait } from './ticketWait.ts';

const wait = async (args: string[], options: SessionOptions = {}) => {
  const plan = makeKindTicket('demo-3467', 'plan', 'draft');
  const fakeSession = makeSession({ tickets: [plan], ...options });
  const { effects } = makeEffects({ session: fakeSession });
  const result = await ticketWait({ args, json: true, effects, session: fakeSession.session });

  return { fakeSession, result };
};

it('appends a waiting fact with its text, and writes no ticket file', async () => {
  const { fakeSession, result } = await wait(['demo-3467', '--text', 'Pick a name']);

  successOf(result);

  expect(fakeSession.appends).toMatchObject([
    {
      machine: 'laptop',
      fact: { kind: 'waiting', ticket: 'demo-3467', waiting: true, text: 'Pick a name' },
    },
  ]);

  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.lockHeld()).toBe(false);
});

it('appends a waiting fact that is false with --done', async () => {
  const { fakeSession, result } = await wait(['demo-3467', '--done']);

  successOf(result);

  expect(fakeSession.appends).toMatchObject([
    { fact: { kind: 'waiting', ticket: 'demo-3467', waiting: false } },
  ]);
});

it('refuses an instruction and appends nothing', async () => {
  const { fakeSession, result } = await wait(['demo-3467'], {
    tickets: [makeKindTicket('demo-3467', 'instruction', 'open')],
  });

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.appends).toEqual([]);
  expect(fakeSession.writes).toEqual([]);
});

it('refuses a plan that is not a draft and appends nothing', async () => {
  const { fakeSession, result } = await wait(['demo-3467'], {
    tickets: [makeKindTicket('demo-3467', 'plan', 'open')],
  });

  expect(failureOf(result).code).toBe('conflict');
  expect(fakeSession.appends).toEqual([]);
});

it('refuses --text together with --done and appends nothing', async () => {
  const { fakeSession, result } = await wait(['demo-3467', '--done', '--text', 'Pick a name']);

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.appends).toEqual([]);
});

it('refuses a missing ID', async () => {
  const { result } = await wait([]);

  expect(failureOf(result).code).toBe('invalidArguments');
});

it('maps an append failure to invalid arguments or a store error by its kind', async () => {
  const failures = [
    { reason: { kind: 'invalid' as const, message: 'Fact is wrong.' }, code: 'invalidArguments' },
    { reason: { kind: 'failed' as const, message: 'Disk is full.' }, code: 'storeError' },
  ];

  for (const { reason, code } of failures) {
    const appendFact = () => Promise.resolve({ ok: false as const, reason });

    const { fakeSession, result } = await wait(['demo-3467', '--done'], {
      overrides: { appendFact },
    });

    expect(failureOf(result)).toMatchObject({ code, message: reason.message });
    expect(fakeSession.lockHeld()).toBe(false);
  }
});
