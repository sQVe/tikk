import { expect, it } from 'bun:test';

import { failureOf, makeEffects, successOf } from './cliHarness.ts';
import { syncCommand } from './syncCommand.ts';

it('reports the sync steps and pending files in json and text', async () => {
  const summary = {
    committed: true,
    pending: ['tickets/demo/fresh.md'],
    aliases: [],
    remote: true,
    fetched: false,
    merged: false,
    pushed: false,
  };

  const { effects } = makeEffects({
    overrides: { syncStore: () => Promise.resolve({ ok: true, value: summary }) },
  });

  const output = successOf(await syncCommand([], effects));

  expect(output.json).toEqual(summary);
  expect(output.text).toContain('tickets/demo/fresh.md');
});

it('passes a conflict through with its code and message', async () => {
  const { effects } = makeEffects({
    overrides: {
      syncStore: () =>
        Promise.resolve({
          ok: false,
          reason: { code: 'conflict', message: 'tickets/demo/a.md changed on both sides.' },
        }),
    },
  });

  const reason = failureOf(await syncCommand([], effects));

  expect(reason).toEqual({ code: 'conflict', message: 'tickets/demo/a.md changed on both sides.' });
});

it('refuses arguments without syncing', async () => {
  const unknown = makeEffects();
  const positional = makeEffects();

  const unknownReason = failureOf(await syncCommand(['--bogus'], unknown.effects));
  const positionalReason = failureOf(await syncCommand(['now'], positional.effects));

  expect(unknownReason.code).toBe('invalidArguments');
  expect(positionalReason.code).toBe('invalidArguments');
  expect(unknown.syncCalls()).toBe(0);
  expect(positional.syncCalls()).toBe(0);
});
