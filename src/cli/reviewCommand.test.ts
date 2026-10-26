import { expect, it } from 'bun:test';

import {
  failureOf,
  makeEffects,
  makeKindTicket,
  makeSession,
  makeTicket,
  successOf,
} from './cliHarness.ts';
import { reviewCommand } from './reviewCommand.ts';

const run = async (args: string[], files: Record<string, string> = {}) => {
  const fakeSession = makeSession({ tickets: [makeTicket('demo-3467')] });
  const { effects } = makeEffects({ session: fakeSession, files });
  const result = await reviewCommand({ args, json: true, effects, session: fakeSession.session });

  return { result, fakeSession };
};

const addFlags = [
  '--repository',
  'tikk',
  '--head',
  'aaa',
  '--base',
  'main',
  '--change-hash',
  'hash1',
  '--capture-hash',
  'capture1',
  '--mode',
  'code',
  '--findings-file',
  '/findings.json',
];

const finding = { fingerprint: 'fp-1', severity: 'high', location: 'a.ts:1', claim: 'Wrong' };

it('refuses an unknown subcommand', async () => {
  const { result } = await run(['nope']);

  expect(failureOf(result).code).toBe('invalidArguments');
});

it('refuses add without a required flag', async () => {
  const withoutMode = addFlags.filter((_, index) => index !== 10 && index !== 11);
  const files = { '/findings.json': '[]' };
  const { result, fakeSession } = await run(['add', 'demo-3467', ...withoutMode], files);

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.appends).toEqual([]);
});

it('refuses add when the findings file is missing, not JSON, or has a bad shape', async () => {
  const files = [
    {},
    { '/findings.json': 'nope' },
    { '/findings.json': JSON.stringify([{ ...finding, severity: 'huge' }]) },
    { '/findings.json': JSON.stringify([{ ...finding, extra: 1 }]) },
  ];

  for (const entry of files) {
    const { result, fakeSession } = await run(['add', 'demo-3467', ...addFlags], entry);

    expect(failureOf(result).code).toBe('invalidArguments');
    expect(fakeSession.appends).toEqual([]);
  }
});

it('refuses ls without an ID', async () => {
  const { result } = await run(['ls']);

  expect(failureOf(result).code).toBe('invalidArguments');
});

it('adds a review to an instruction', async () => {
  const { result, fakeSession } = await run(['add', 'demo-3467', ...addFlags], {
    '/findings.json': '[]',
  });

  successOf(result);
  expect(fakeSession.appends).toHaveLength(1);
});

it('refuses a review on a plan, names its kind, and appends nothing', async () => {
  const fakeSession = makeSession({ tickets: [makeKindTicket('demo-3467', 'plan')] });
  const { effects } = makeEffects({ session: fakeSession, files: { '/findings.json': '[]' } });

  const result = await reviewCommand({
    args: ['add', 'demo-3467', ...addFlags],
    json: true,
    effects,
    session: fakeSession.session,
  });

  expect(failureOf(result).message).toContain('plan');
  expect(fakeSession.appends).toEqual([]);
});

it('adds a review to a slice', async () => {
  const fakeSession = makeSession({ tickets: [makeKindTicket('demo-3467', 'slice')] });
  const { effects } = makeEffects({ session: fakeSession, files: { '/findings.json': '[]' } });

  const result = await reviewCommand({
    args: ['add', 'demo-3467', ...addFlags],
    json: true,
    effects,
    session: fakeSession.session,
  });

  successOf(result);
  expect(fakeSession.appends).toHaveLength(1);
});
