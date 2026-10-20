import { expect, it } from 'bun:test';

import { failed, failureOf, makeEffects, successOf } from './cliHarness.ts';
import { cliInit } from './cliInit.ts';

it('reports a created store in json and text', async () => {
  const { effects } = makeEffects();
  const output = successOf(await cliInit([], effects));

  expect(output.json).toEqual({ store: '/store', created: true });
  expect(output.text).toContain('/store');
});

it('reports an existing store as not created', async () => {
  const created = makeEffects();

  const found = makeEffects({
    overrides: {
      initStore: () => Promise.resolve({ ok: true, value: { store: '/store', created: false } }),
    },
  });

  const createdOutput = successOf(await cliInit([], created.effects));
  const foundOutput = successOf(await cliInit([], found.effects));

  expect(foundOutput.json).toEqual({ store: '/store', created: false });
  expect(foundOutput.text).toContain('/store');
  expect(foundOutput.text).not.toBe(createdOutput.text);
});

it('refuses unknown arguments without touching the store', async () => {
  const fake = makeEffects();
  const reason = failureOf(await cliInit(['--bogus'], fake.effects));

  expect(reason.code).toBe('invalidArguments');
  expect(fake.initCalls()).toBe(0);
});

it('refuses a positional argument without touching the store', async () => {
  const fake = makeEffects();
  const reason = failureOf(await cliInit(['typo'], fake.effects));

  expect(reason.code).toBe('invalidArguments');
  expect(reason.message).toContain('init');
  expect(fake.initCalls()).toBe(0);
});

it('returns a storeError with the message when the store cannot be created', async () => {
  const { effects } = makeEffects({
    overrides: { initStore: () => failed('Cannot create /store.') },
  });

  const reason = failureOf(await cliInit([], effects));

  expect(reason.code).toBe('storeError');
  expect(reason.message).toContain('/store');
});
