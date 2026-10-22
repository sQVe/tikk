import { expect, it } from 'bun:test';

import type { Fact } from '../fact/fact.ts';
import {
  failureOf,
  fakeGh,
  makeEffects,
  makeFact,
  makeKindTicket,
  makeSession,
  successOf,
} from './cliHarness.ts';
import { prCommand } from './prLink.ts';

const url = 'https://github.com/acme/app/pull/7';

const link = async (
  args: string[],
  gh: Parameters<typeof fakeGh>[0],
  options: { kind?: 'slice' | 'task'; facts?: Fact[] } = {},
) => {
  const fakeSession = makeSession({
    tickets: [makeKindTicket('demo-3467', options.kind ?? 'slice')],
    facts: options.facts ?? [],
  });

  const fakeEffects = makeEffects({ session: fakeSession, runGh: fakeGh(gh) });

  const result = await prCommand({
    args: ['link', ...args],
    json: true,
    effects: fakeEffects.effects,
    session: fakeSession.session,
  });

  return { result, appends: fakeSession.appends, ghCalls: fakeEffects.ghCalls };
};

it('links an open PR and shows the slice as in review', async () => {
  const { result, appends } = await link(['demo-3467', url], { 7: { state: 'OPEN' } });

  expect(appends).toHaveLength(1);

  expect(appends[0]?.fact).toMatchObject({
    kind: 'pr',
    ticket: 'demo-3467',
    repository: 'acme/app',
    number: 7,
    state: 'open',
    inTrunk: false,
  });

  expect(successOf(result).json).toMatchObject({ id: 'demo-3467', state: 'inReview' });
});

it('links a closed PR', async () => {
  const { appends } = await link(['demo-3467', url], { 7: { state: 'CLOSED' } });

  expect(appends[0]?.fact).toMatchObject({ kind: 'pr', state: 'closed' });
});

it('appends nothing when the same PR is linked again unchanged', async () => {
  const known = makeFact({
    kind: 'pr',
    repository: 'acme/app',
    number: 7,
    state: 'open',
    base: 'main',
    head: 'head1',
    trunk: 'main',
    inTrunk: false,
  });

  const { result, appends } = await link(
    ['demo-3467', url],
    { 7: { state: 'OPEN' } },
    { facts: [known] },
  );

  expect(result.ok).toBe(true);
  expect(appends).toEqual([]);
});

it('refuses a task ticket and does not call gh', async () => {
  const { result, appends, ghCalls } = await link(
    ['demo-3467', url],
    { 7: { state: 'OPEN' } },
    { kind: 'task' },
  );

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(appends).toEqual([]);
  expect(ghCalls).toEqual([]);
});

it('refuses a URL that is not a pull request URL', async () => {
  const { result, appends, ghCalls } = await link(
    ['demo-3467', 'https://github.com/acme/app/issues/7'],
    { 7: { state: 'OPEN' } },
  );

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(appends).toEqual([]);
  expect(ghCalls).toEqual([]);
});

it('returns ghError and appends nothing when gh fails', async () => {
  const { result, appends } = await link(['demo-3467', url], {
    7: { state: 'OPEN', error: 'not logged in' },
  });

  const failure = failureOf(result);

  expect(failure.code).toBe('ghError');
  expect(failure.message).toContain('not logged in');
  expect(appends).toEqual([]);
});
