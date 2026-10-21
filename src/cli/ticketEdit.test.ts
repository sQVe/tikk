import { expect, it } from 'bun:test';

import {
  failed,
  failureOf,
  makeFact,
  makeKindTicket,
  makeEffects,
  makeSession,
  makeTicket,
  successOf,
} from './cliHarness.ts';
import type { EffectsOptions, SessionOptions } from './cliHarness.ts';
import { ticketEdit } from './ticketEdit.ts';
import { ticketShow } from './ticketShow.ts';

const target = makeTicket('demo-3467');
const criterion = { id: 'works', check: 'bun test', expected: 'It passes.' };
const criteriaArgs = ['--criteria-file', '/work/criteria.yaml'];

const criteriaFiles: EffectsOptions = {
  files: { '/work/criteria.yaml': '- id: works\n  check: bun test\n  expected: It passes.\n' },
};

const edit = (
  args: string[],
  json: boolean,
  sessionOptions: SessionOptions = {},
  effectsOptions: EffectsOptions = {},
) => {
  const fakeSession = makeSession({ tickets: [target], ...sessionOptions });
  const fakeEffects = makeEffects({ session: fakeSession, ...effectsOptions });

  const { effects } = fakeEffects;
  const { session } = fakeSession;
  const result = ticketEdit({ args, json, effects, session });

  return { fakeSession, fakeEffects, result };
};

it('writes a changed title and status with the expected hash, then shows the ticket', async () => {
  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'hash-demo-3467', '--title', 'New', '--status', 'draft'],
    true,
  );

  const output = successOf(await result);

  expect(output.json).toMatchObject({ id: 'demo-3467' });
  expect(fakeSession.writes).toHaveLength(1);
  expect(fakeSession.writes[0]?.path).toBe(target.path);
  expect(fakeSession.writes[0]?.expectedHash).toBe('hash-demo-3467');
  expect(fakeSession.writes[0]?.text).toContain('title: New');
  expect(fakeSession.writes[0]?.text).toContain('status: draft');
  expect(fakeSession.writes[0]?.text).toEndWith('A body\n');
});

it('keeps the title and status that are not given', async () => {
  const { fakeSession, result } = edit(['demo-3467', '--hash', 'h', '--title', 'New'], true);

  successOf(await result);

  expect(fakeSession.writes[0]?.text).toContain('status: open');
});

it('keeps the title when only the status is given', async () => {
  const { fakeSession, result } = edit(['demo-3467', '--hash', 'h', '--status', 'draft'], true);

  successOf(await result);

  expect(fakeSession.writes[0]?.text).toContain('title: A title');
});

it('replaces the body from --body-file', async () => {
  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--body-file', '/body.md'],
    true,
    {},
    { files: { '/body.md': 'Fresh\n' } },
  );

  successOf(await result);

  expect(fakeSession.writes[0]?.text).toEndWith('Fresh\n');
  expect(fakeSession.writes[0]?.text).not.toContain('A body');
});

const refusals: [string, string[], boolean][] = [
  ['no ID', ['--hash', 'h', '--title', 'New'], true],
  ['extra positionals', ['demo-3467', 'demo-3468', '--hash', 'h', '--title', 'New'], true],
  ['an unknown option', ['demo-3467', '--bogus'], true],
  ['no field in json mode', ['demo-3467', '--hash', 'h'], true],
  ['a field without --hash', ['demo-3467', '--title', 'New'], false],
  ['an empty title', ['demo-3467', '--hash', 'h', '--title', ''], true],
  ['a closed task', ['demo-3467', '--hash', 'h', '--status', 'closed'], true],
  ['an unknown status', ['demo-3467', '--hash', 'h', '--status', 'nope'], true],
  ['a missing body file', ['demo-3467', '--hash', 'h', '--body-file', '/missing.md'], true],
];

for (const [name, args, json] of refusals) {
  it(`refuses ${name} and writes nothing`, async () => {
    const { fakeSession, fakeEffects, result } = edit(args, json);

    expect(failureOf(await result).code).toBe('invalidArguments');
    expect(fakeSession.writes).toEqual([]);
    expect(fakeEffects.editorPaths).toEqual([]);
  });
}

it('names the missing body file in the error', async () => {
  const { result } = edit(['demo-3467', '--hash', 'h', '--body-file', '/missing.md'], true);

  expect(failureOf(await result).message).toContain('/missing.md');
});

it('gives a message for a rejected front matter', async () => {
  const { result } = edit(['demo-3467', '--hash', 'h', '--status', 'closed'], true);

  const reason = failureOf(await result);

  expect(reason.code).toBe('invalidArguments');
  expect(reason.message).toContain('closed');
});

it('returns notFound naming the ID and writes nothing for an unknown ticket', async () => {
  const { fakeSession, result } = edit(['demo-3468', '--hash', 'h', '--title', 'New'], true);
  const reason = failureOf(await result);

  expect(reason.code).toBe('notFound');
  expect(reason.message).toContain('demo-3468');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses a ticket that has a parse error and writes nothing', async () => {
  const broken = makeTicket('demo-3467', { error: 'Bad YAML.' });

  const { fakeSession, result } = edit(['demo-3467', '--hash', 'h', '--title', 'New'], true, {
    tickets: [broken],
  });

  const reason = failureOf(await result);

  expect(reason.code).toBe('parseError');
  expect(reason.message).toContain(broken.path);
  expect(reason.message).toContain('Bad YAML.');
  expect(fakeSession.writes).toEqual([]);
});

it('maps a hash mismatch to changedOnDisk', async () => {
  const { result } = edit(['demo-3467', '--hash', 'old', '--title', 'New'], true, {
    overrides: {
      writeTicketFile: () =>
        Promise.resolve({
          ok: false,
          reason: { kind: 'changedOnDisk', message: 'demo-3467 changed on disk.' },
        }),
    },
  });

  const reason = failureOf(await result);

  expect(reason.code).toBe('changedOnDisk');
  expect(reason.message).toContain('demo-3467');
});

it('maps other write failures to storeError', async () => {
  const kinds = ['notFound', 'failed'] as const;

  for (const kind of kinds) {
    const { result } = edit(['demo-3467', '--hash', 'h', '--title', 'New'], true, {
      overrides: {
        writeTicketFile: () =>
          Promise.resolve({ ok: false, reason: { kind, message: 'Cannot write /store.' } }),
      },
    });

    const reason = failureOf(await result);

    expect(reason.code).toBe('storeError');
    expect(reason.message).toContain('/store');
  }
});

it('names --hash when a field edit has no hash', async () => {
  const { result } = edit(['demo-3467', '--title', 'New'], false);

  expect(failureOf(await result).message).toContain('--hash');
});

it('names the fields to give when json mode has none', async () => {
  const { result } = edit(['demo-3467', '--hash', 'h'], true);
  const { message } = failureOf(await result);

  expect(message).toContain('--title');
  expect(message).toContain('--body-file');
});

it('writes a JSON edit under the store lock after a refresh', async () => {
  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'hash-demo-3467', '--title', 'New'],
    true,
  );

  successOf(await result);

  expect(fakeSession.writes.map((write) => write.underLock)).toEqual([true]);
  expect(fakeSession.lockHeld()).toBe(false);
});

it('edits the ticket as it is on disk after the lock is taken, then shows the written file', async () => {
  const fakeSession = makeSession({ tickets: [target] });
  const fakeEffects = makeEffects({ session: fakeSession });
  const lockStore = fakeSession.session.lockStore;
  const changed = makeTicket('demo-3467', { hash: 'hash-changed' });

  fakeSession.session.lockStore = async () => {
    fakeSession.changeOnDisk({
      ...changed,
      frontMatter: { ...changed.frontMatter, title: 'Changed meanwhile' },
    });

    return lockStore();
  };

  const output = successOf(
    await ticketEdit({
      args: ['demo-3467', '--hash', 'hash-demo-3467', '--status', 'draft'],
      json: true,
      effects: fakeEffects.effects,
      session: fakeSession.session,
    }),
  );

  expect(fakeSession.writes[0]?.text).toContain('title: Changed meanwhile');
  expect(output.json).toMatchObject({ title: 'Changed meanwhile' });
});

it('fails with locked and writes nothing when the store lock is held', async () => {
  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'hash-demo-3467', '--title', 'New'],
    true,
    {
      overrides: {
        lockStore: () =>
          Promise.resolve({
            ok: false as const,
            reason: { kind: 'locked' as const, message: 'The store is locked by process 42.' },
          }),
      },
    },
  );

  expect(failureOf(await result).code).toBe('locked');
  expect(fakeSession.writes).toEqual([]);
});

it('prints the derived state of a done task in the text after an edit', async () => {
  const { result } = edit(['demo-3467', '--hash', 'hash-demo-3467', '--title', 'New'], false, {
    facts: [makeFact({ kind: 'accept' })],
  });

  const output = successOf(await result);

  expect(output.text).toContain('demo-3467  done');
});

it('turns an issue into a slice under a plan and keeps its ID and path', async () => {
  const issue = makeKindTicket('demo-3467', 'issue');
  const plan = makeKindTicket('demo-3468', 'plan');

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'slice', '--parent', 'demo-3468', ...criteriaArgs],
    true,
    { tickets: [issue, plan] },
    criteriaFiles,
  );

  expect(successOf(await result).json).toMatchObject({ id: 'demo-3467', path: issue.path });
  expect(fakeSession.writes).toHaveLength(1);
  expect(fakeSession.writes[0]?.path).toBe(issue.path);
  expect(fakeSession.writes[0]?.text).toContain('kind: slice');
  expect(fakeSession.writes[0]?.text).toContain('parent: demo-3468');
  expect(fakeSession.appends).toEqual([]);
});

it('turns an issue into a plan', async () => {
  const issue = makeKindTicket('demo-3467', 'issue');

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'plan', ...criteriaArgs],
    true,
    { tickets: [issue] },
    criteriaFiles,
  );

  successOf(await result);
  expect(fakeSession.writes[0]?.text).toContain('kind: plan');
});

it('turns a draft issue into a draft slice without criteria', async () => {
  const issue = makeKindTicket('demo-3467', 'issue', 'draft');

  const { fakeSession, result } = edit(['demo-3467', '--hash', 'h', '--kind', 'slice'], true, {
    tickets: [issue],
  });

  successOf(await result);
  expect(fakeSession.writes[0]?.text).toContain('kind: slice');
});

it('refuses to turn an open issue into a slice without criteria and writes nothing', async () => {
  const issue = makeKindTicket('demo-3467', 'issue');

  const { fakeSession, result } = edit(['demo-3467', '--hash', 'h', '--kind', 'slice'], true, {
    tickets: [issue],
  });

  expect(failureOf(await result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
});

it('turns an open issue into a slice with the criteria of --criteria-file', async () => {
  const issue = makeKindTicket('demo-3467', 'issue');

  const { fakeSession, fakeEffects, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'slice', ...criteriaArgs],
    true,
    { tickets: [issue] },
    criteriaFiles,
  );

  successOf(await result);

  const shown = await ticketShow({
    args: ['demo-3467'],
    json: true,
    effects: fakeEffects.effects,
    session: fakeSession.session,
  });

  expect(successOf(shown).json).toMatchObject({ kind: 'slice', criteria: [criterion] });
});

it('refuses a criteria file that cannot be read and writes nothing', async () => {
  const issue = makeKindTicket('demo-3467', 'issue', 'draft');

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'slice', ...criteriaArgs],
    true,
    { tickets: [issue] },
  );

  expect(failureOf(await result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses --kind on a task and writes nothing', async () => {
  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'slice', ...criteriaArgs],
    true,
    {},
    criteriaFiles,
  );

  expect(failureOf(await result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses --kind on a slice and writes nothing', async () => {
  const slice = makeKindTicket('demo-3467', 'slice');

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'plan', ...criteriaArgs],
    true,
    { tickets: [slice] },
    criteriaFiles,
  );

  expect(failureOf(await result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses a kind other than slice or plan', async () => {
  const issue = makeKindTicket('demo-3467', 'issue');

  const { fakeSession, result } = edit(['demo-3467', '--hash', 'h', '--kind', 'task'], true, {
    tickets: [issue],
  });

  expect(failureOf(await result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses --parent without --kind slice', async () => {
  const issue = makeKindTicket('demo-3467', 'issue');
  const plan = makeKindTicket('demo-3468', 'plan');

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'plan', '--parent', 'demo-3468'],
    true,
    { tickets: [issue, plan] },
  );

  expect(failureOf(await result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses a parent that is not a plan and writes nothing', async () => {
  const issue = makeKindTicket('demo-3467', 'issue');
  const other = makeKindTicket('demo-3468', 'issue');

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'slice', '--parent', 'demo-3468', ...criteriaArgs],
    true,
    { tickets: [issue, other] },
    criteriaFiles,
  );

  expect(failureOf(await result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('appends a status fact when --status changes the status', async () => {
  const { fakeSession, result } = edit(['demo-3467', '--hash', 'h', '--status', 'draft'], true);

  successOf(await result);
  expect(fakeSession.appends).toHaveLength(1);

  expect(fakeSession.appends[0]?.fact).toMatchObject({
    kind: 'status',
    ticket: 'demo-3467',
    status: 'draft',
  });
});

it('appends no status fact when the status stays the same', async () => {
  const { fakeSession, result } = edit(['demo-3467', '--hash', 'h', '--status', 'open'], true);

  successOf(await result);
  expect(fakeSession.appends).toEqual([]);
});

it('refuses --parent without --kind and writes nothing', async () => {
  const plan = makeKindTicket('demo-3468', 'plan');

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--parent', 'demo-3468'],
    true,
    {
      tickets: [target, plan],
    },
  );

  expect(failureOf(await result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses to move a task to another slice with --parent and writes nothing', async () => {
  const slice = makeKindTicket('demo-3468', 'slice');

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--parent', 'demo-3468'],
    true,
    {
      tickets: [target, slice],
    },
  );

  expect(failureOf(await result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses a --parent that is not a valid ID with invalidArguments and writes nothing', async () => {
  const issue = makeKindTicket('demo-3467', 'issue');

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'slice', '--parent', 'Not An ID', ...criteriaArgs],
    true,
    { tickets: [issue] },
    criteriaFiles,
  );

  expect(failureOf(await result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('edits a title without a machine name, since no status fact is needed', async () => {
  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--title', 'New'],
    true,
    {},
    { overrides: { resolveMachine: () => failed('No machine.') } },
  );

  successOf(await result);
  expect(fakeSession.writes).toHaveLength(1);
});
