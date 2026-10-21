import { expect, it } from 'bun:test';

import { parseTicketFile } from '../ticket/ticket.ts';
import type { CliSession, CliTicket } from './cliEffects.ts';
import {
  failed,
  failureOf,
  makeEffects,
  makeSession,
  makeTicket,
  projectNameOf,
  successOf,
} from './cliHarness.ts';
import type { EffectsOptions, SessionOptions } from './cliHarness.ts';
import { ticketNew } from './ticketNew.ts';

const create = (
  args: string[],
  effectsOptions: EffectsOptions = {},
  sessionOverrides: Partial<CliSession> = {},
  sessionOptions: SessionOptions = {},
) => {
  const fakeSession = makeSession({
    created: makeTicket('demo-3467', { body: 'Made\n' }),
    ...sessionOptions,
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

const ticketOfKind = (id: string, kind: 'plan' | 'slice' | 'task' | 'issue'): CliTicket =>
  makeTicket(id, {
    frontMatter: {
      kind,
      title: 'Existing',
      project: projectNameOf('demo'),
      blockedBy: [],
      discoveredFrom: [],
      related: [],
      status: 'open',
    },
  });

const slice = (id: string): CliTicket => ticketOfKind(id, 'slice');

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
      'task',
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
    {},
    { tickets: [slice('other-3468')] },
  );

  successOf(await result);

  const created = fakeSession.creates[0];

  expect(created?.project).toBe('other');
  expect(created?.text).toContain('kind: task');
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

const treeRefusals: [string, string[], SessionOptions, string][] = [
  [
    'a plan with a parent',
    ['plan', 'Title', '--parent', 'demo-3468', '--status', 'draft'],
    { tickets: [slice('demo-3468')] },
    'demo-3468',
  ],
  [
    'a task whose parent is a plan',
    ['task', 'Title', '--parent', 'demo-3468'],
    { tickets: [ticketOfKind('demo-3468', 'plan')] },
    'demo-3468',
  ],
  [
    'a slice whose parent is missing',
    ['slice', 'Title', '--parent', 'demo-3469', '--criteria-file', '/criteria.yaml'],
    {},
    'demo-3469',
  ],
  ['a missing blocked-by target', ['task', 'Title', '--blocked-by', 'demo-3473'], {}, 'demo-3473'],
  [
    'a missing discovered-from target',
    ['issue', 'Title', '--discovered-from', 'demo-3474'],
    {},
    'demo-3474',
  ],
  ['a missing related target', ['issue', 'Title', '--related', 'demo-3475'], {}, 'demo-3475'],
];

for (const [name, args, sessionOptions, mention] of treeRefusals) {
  it(`refuses ${name} and writes no file`, async () => {
    const { fakeSession, result } = create(
      args,
      { files: { '/criteria.yaml': criteriaYaml } },
      {},
      sessionOptions,
    );

    const reason = failureOf(await result);

    expect(reason.code).toBe('invalidArguments');
    expect(reason.message).toContain(mention);
    expect(fakeSession.creates).toEqual([]);
  });
}

it('accepts a link to an archived ticket', async () => {
  const archived = makeTicket('demo-3468', {
    frontMatter: { ...ticketOfKind('demo-3468', 'task').frontMatter, archived: '2026-10-01' },
  });

  const { fakeSession, result } = create(
    ['task', 'Title', '--blocked-by', 'demo-3468'],
    {},
    {},
    {
      tickets: [archived],
    },
  );

  successOf(await result);

  expect(fakeSession.creates[0]?.text).toContain('demo-3468');
});

const criteriaYaml = `- id: works
  check: Run the command.
  expected: It prints ok.
`;

it('shows the criteria of a new open plan made with --criteria-file', async () => {
  const { result } = create(
    ['plan', 'Plan', '--criteria-file', '/criteria.yaml'],
    { files: { '/criteria.yaml': criteriaYaml } },
    {},
    { readBack: true },
  );

  const output = successOf(await result);

  expect(output.json).toMatchObject({
    kind: 'plan',
    status: 'open',
    criteria: [{ id: 'works', check: 'Run the command.', expected: 'It prints ok.' }],
  });
});

const criteriaRefusals: [string, string[]][] = [
  ['an open plan without criteria', ['plan', 'Plan']],
  ['an open slice without criteria', ['slice', 'Slice']],
  ['criteria on a task', ['task', 'Title', '--criteria-file', '/criteria.yaml']],
  [
    'a criteria file that is not a list',
    ['plan', 'Plan', '--status', 'draft', '--criteria-file', '/notList.yaml'],
  ],
  [
    'a missing criteria file',
    ['plan', 'Plan', '--status', 'draft', '--criteria-file', '/missing.yaml'],
  ],
  [
    'a criteria file that is not YAML',
    ['plan', 'Plan', '--status', 'draft', '--criteria-file', '/broken.yaml'],
  ],
  ['a blank rank', ['task', 'Title', '--rank', ' ']],
  ['a blockedBy ID that is not valid', ['task', 'Title', '--blocked-by', 'Not An ID']],
  ['a discoveredFrom ID that is not valid', ['task', 'Title', '--discovered-from', 'Not An ID']],
  ['covers on a plan', ['plan', 'Plan', '--criteria-file', '/criteria.yaml', '--covers', 'works']],
  ['a rank that is not a number', ['task', 'Title', '--rank', 'high']],
];

for (const [name, args] of criteriaRefusals) {
  it(`refuses ${name} and writes no file`, async () => {
    const { fakeSession, result } = create(args, {
      files: {
        '/criteria.yaml': criteriaYaml,
        '/notList.yaml': 'id: works\n',
        '/broken.yaml': '- [unclosed\n',
      },
    });

    expect(failureOf(await result).code).toBe('invalidArguments');
    expect(fakeSession.creates).toEqual([]);
  });
}

it('creates a draft plan without criteria', async () => {
  const { fakeSession, result } = create(['plan', 'Plan', '--status', 'draft']);

  successOf(await result);

  expect(fakeSession.creates).toHaveLength(1);
});

it('writes rank, edges, and covers into the front matter', async () => {
  const { fakeSession, result } = create(
    [
      'task',
      'Title',
      '--rank',
      '2.5',
      '--blocked-by',
      'demo-3468',
      '--blocked-by',
      'demo-3469',
      '--related',
      'demo-3468',
      '--discovered-from',
      'demo-3469',
      '--covers',
      'works',
    ],
    {},
    {},
    { tickets: [slice('demo-3468'), slice('demo-3469')] },
  );

  successOf(await result);

  const written = parseTicketFile(fakeSession.creates[0]?.text ?? '');

  expect(written.ok && written.value.frontMatter).toMatchObject({
    rank: 2.5,
    blockedBy: ['demo-3468', 'demo-3469'],
    related: ['demo-3468'],
    discoveredFrom: ['demo-3469'],
    covers: ['works'],
  });
});

it('returns a storeError and creates nothing when the refresh under the lock fails', async () => {
  const { fakeSession, result } = create(
    ['task', 'Title'],
    {},
    { refresh: () => failed('The cache failed.') },
  );

  expect(failureOf(await result).code).toBe('storeError');
  expect(fakeSession.creates).toEqual([]);
});
