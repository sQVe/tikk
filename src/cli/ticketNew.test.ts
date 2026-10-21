import { expect, it } from 'bun:test';

import { parseTicketFile } from '../ticket/ticket.ts';
import type { CliSession } from './cliEffects.ts';
import {
  failed,
  failureOf,
  makeEffects,
  makeSession,
  makeTicket,
  successOf,
} from './cliHarness.ts';
import type { EffectsOptions } from './cliHarness.ts';
import { ticketNew } from './ticketNew.ts';

const create = (
  args: string[],
  effectsOptions: EffectsOptions = {},
  sessionOverrides: Partial<CliSession> = {},
) => {
  const fakeSession = makeSession({
    created: makeTicket('demo-3467', { body: 'Made\n' }),
    overrides: sessionOverrides,
  });

  const fakeEffects = makeEffects({ session: fakeSession, ...effectsOptions });

  const result = ticketNew({
    args,
    json: false,
    effects: fakeEffects.effects,
    session: fakeSession.session,
  });

  return { fakeSession, fakeEffects, result };
};

it('creates a ticket in the resolved project and shows it', async () => {
  const { fakeSession, fakeEffects, result } = create(['task', 'My title']);
  const output = successOf(await result);

  expect(output.json).toMatchObject({ id: 'demo-3467', body: 'Made\n' });
  expect(fakeSession.creates).toHaveLength(1);
  expect(fakeSession.creates[0]?.project).toBe('demo');
  expect(fakeSession.creates[0]?.title).toBe('My title');
  expect(fakeSession.creates[0]?.text).toContain('title: My title');
  expect(fakeSession.creates[0]?.text).toContain('kind: task');
  expect(fakeSession.creates[0]?.text).toContain('status: open');
  expect(fakeEffects.resolveCalls()).toBe(1);
});

it('uses --project, --parent, --status, and --body-file', async () => {
  const { fakeSession, fakeEffects, result } = create(
    [
      'issue',
      'Title',
      '--project',
      'other',
      '--parent',
      'other-3468',
      '--status',
      'draft',
      '--body-file',
      '/body.md',
    ],
    { files: { '/body.md': 'From file\n' } },
  );

  successOf(await result);

  const created = fakeSession.creates[0];

  expect(created?.project).toBe('other');
  expect(created?.text).toContain('kind: issue');
  expect(created?.text).toContain('parent: other-3468');
  expect(created?.text).toContain('status: draft');
  expect(created?.text).toEndWith('From file\n');
  expect(fakeEffects.resolveCalls()).toBe(0);
});

it('writes an empty body without --body-file', async () => {
  const { fakeSession, result } = create(['task', 'Title']);

  successOf(await result);

  const written = parseTicketFile(fakeSession.creates[0]?.text ?? '');

  expect(written.ok && written.value.body).toBe('');
});

const refusals: [string, string[]][] = [
  ['no kind', []],
  ['no title', ['task']],
  ['extra positionals', ['task', 'Title', 'more']],
  ['an unknown option', ['task', 'Title', '--bogus']],
  ['an invalid kind', ['epic', 'Title']],
  ['an empty title', ['task', '']],
  ['a closed task', ['task', 'Title', '--status', 'closed']],
  ['an invalid project', ['task', 'Title', '--project', 'Bad Name']],
  ['an invalid parent', ['task', 'Title', '--parent', 'nonsense']],
  ['a missing body file', ['task', 'Title', '--body-file', '/missing.md']],
];

for (const [name, args] of refusals) {
  it(`refuses ${name} and writes nothing`, async () => {
    const { fakeSession, result } = create(args);

    expect(failureOf(await result).code).toBe('invalidArguments');
    expect(fakeSession.creates).toEqual([]);
  });
}

it('names the invalid project in the error', async () => {
  const { result } = create(['task', 'Title', '--project', 'Bad Name']);

  expect(failureOf(await result).message).toContain('Bad Name');
});

it('names the invalid parent in the error', async () => {
  const { result } = create(['task', 'Title', '--parent', 'nonsense']);

  expect(failureOf(await result).message).toContain('nonsense');
});

it('names the missing body file in the error', async () => {
  const { result } = create(['task', 'Title', '--body-file', '/missing.md']);

  expect(failureOf(await result).message).toContain('/missing.md');
});

it('gives a message for a rejected front matter', async () => {
  const { result } = create(['task', 'Title', '--status', 'closed']);

  const reason = failureOf(await result);

  expect(reason.code).toBe('invalidArguments');
  expect(reason.message).toContain('closed');
});

it('fails with the project message when the project cannot be resolved', async () => {
  const { fakeSession, result } = create(['task', 'Title'], {
    overrides: { resolveProject: () => failed('No git remote for /work.') },
  });

  const reason = failureOf(await result);

  expect(reason.code).toBe('invalidArguments');
  expect(reason.message).toContain('/work');
  expect(fakeSession.creates).toEqual([]);
});

it('returns a storeError when the file cannot be created', async () => {
  const fakeSession = makeSession({
    overrides: {
      createTicketFile: () =>
        Promise.resolve({ ok: false, reason: { kind: 'failed', message: 'Disk full at /store.' } }),
    },
  });

  const { effects } = makeEffects({ session: fakeSession });

  const reason = failureOf(
    await ticketNew({
      args: ['task', 'Title'],
      json: false,
      effects,
      session: fakeSession.session,
    }),
  );

  expect(reason.code).toBe('storeError');
  expect(reason.message).toContain('/store');
});

it('refuses a missing title before it resolves the project', async () => {
  const { fakeSession, fakeEffects, result } = create(['task']);

  expect(failureOf(await result).code).toBe('invalidArguments');
  expect(fakeEffects.resolveCalls()).toBe(0);
  expect(fakeSession.creates).toHaveLength(0);
});

it('creates the ticket file under the store lock', async () => {
  const { fakeSession, result } = create(['task', 'My title']);

  successOf(await result);

  expect(fakeSession.creates.map((created) => created.underLock)).toEqual([true]);
  expect(fakeSession.lockHeld()).toBe(false);
});

it('fails with locked and creates nothing when the store lock is held', async () => {
  const { fakeSession, result } = create(
    ['task', 'My title'],
    {},
    {
      lockStore: () =>
        Promise.resolve({
          ok: false as const,
          reason: { kind: 'locked' as const, message: 'The store is locked by process 42.' },
        }),
    },
  );

  expect(failureOf(await result).code).toBe('locked');
  expect(fakeSession.creates).toEqual([]);
});
