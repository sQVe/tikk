import { expect, it } from 'bun:test';

import type { CliEffects } from './cliEffects.ts';
import { failureOf, makeEffects, makeSession, makeTicket, successOf } from './cliHarness.ts';
import type { EffectsOptions, SessionOptions } from './cliHarness.ts';
import { ticketEditor } from './ticketEditor.ts';

const target = makeTicket('demo-3467');

const failEditor: CliEffects['runEditor'] = () =>
  Promise.resolve({ ok: false, reason: { kind: 'failed', message: 'Editor exited for /store.' } });

const open = (
  rawId: string,
  sessionOptions: SessionOptions = {},
  effectsOptions: EffectsOptions = {},
) => {
  const fakeSession = makeSession({ tickets: [target], ...sessionOptions });
  const fakeEffects = makeEffects({ session: fakeSession, ...effectsOptions });

  const result = ticketEditor(
    { args: [rawId], json: false, effects: fakeEffects.effects, session: fakeSession.session },
    rawId,
  );

  return { fakeSession, fakeEffects, result };
};

it('opens the editor on the ticket path without --json and shows the edited file', async () => {
  const fakeSession = makeSession({ tickets: [target] });

  const fakeEffects = makeEffects({
    session: fakeSession,
    overrides: {
      runEditor: () => {
        fakeSession.changeOnDisk(makeTicket('demo-3467', { hash: 'hash-edited' }));

        return Promise.resolve({ ok: true, value: undefined });
      },
    },
  });

  const output = successOf(
    await ticketEditor(
      {
        args: ['demo-3467'],
        json: false,
        effects: fakeEffects.effects,
        session: fakeSession.session,
      },
      'demo-3467',
    ),
  );

  expect(output.json).toMatchObject({ id: 'demo-3467', hash: 'hash-edited' });
  expect(fakeSession.writes).toEqual([]);
});

it('does not open the editor for an unknown ticket', async () => {
  const { fakeEffects, result } = open('demo-3468');
  const reason = failureOf(await result);

  expect(reason.code).toBe('notFound');
  expect(reason.message).toContain('demo-3468');
  expect(fakeEffects.editorPaths).toEqual([]);
});

it('does not open the editor for an invalid ID', async () => {
  const { fakeEffects, result } = open('nonsense');
  const reason = failureOf(await result);

  expect(reason.code).toBe('notFound');
  expect(reason.message).toContain('nonsense');
  expect(fakeEffects.editorPaths).toEqual([]);
});

it('returns a storeError when the editor fails', async () => {
  const { result } = open('demo-3467', {}, { overrides: { runEditor: failEditor } });

  const reason = failureOf(await result);

  expect(reason.code).toBe('storeError');
  expect(reason.message).toContain('/store');
});

it('does not look up the path of an invalid ID', async () => {
  const lookups: string[] = [];

  const { fakeEffects, result } = open('nonsense', {
    overrides: {
      findTicketPath: (id) => {
        lookups.push(id);

        return { ok: false, reason: { kind: 'notFound', message: 'missing' } };
      },
    },
  });

  await result;

  expect(lookups).toHaveLength(0);
  expect(fakeEffects.editorPaths).toHaveLength(0);
});

it('schedules one background sync after the editor succeeds', async () => {
  const { fakeEffects, result } = open(
    'demo-3467',
    {},
    {
      overrides: { runEditor: () => Promise.resolve({ ok: true, value: undefined }) },
    },
  );

  await result;

  expect(fakeEffects.scheduleCalls()).toBe(1);
});

it('schedules no background sync when the editor fails', async () => {
  const { fakeEffects, result } = open('demo-3467', {}, { overrides: { runEditor: failEditor } });

  await result;

  expect(fakeEffects.scheduleCalls()).toBe(0);
});
