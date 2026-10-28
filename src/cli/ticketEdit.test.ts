import { expect, it } from 'bun:test';

import { parseTicketFile } from '../ticket/ticket.ts';
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

const parent = makeKindTicket('demo-3468', 'slice');

const target = makeTicket('demo-3467', {
  frontMatter: { ...makeTicket('demo-3467').frontMatter, parent: parent.id },
});

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
  const fakeSession = makeSession({ tickets: [parent, target], ...sessionOptions });
  const fakeEffects = makeEffects({ session: fakeSession, ...effectsOptions });

  const { effects } = fakeEffects;
  const { session } = fakeSession;
  const result = ticketEdit({ args, json, effects, session });

  return { fakeSession, fakeEffects, result };
};

it('refuses a field flag with --design and opens no editor', async () => {
  const { fakeSession, fakeEffects, result } = edit(
    ['demo-3467', '--design', '--title', 'Other'],
    true,
  );

  const reason = failureOf(await result);

  expect(reason.code).toBe('invalidArguments');
  expect(reason.message).toContain('--design cannot be combined with field flags');
  expect(fakeEffects.editorPaths).toEqual([]);
  expect(fakeSession.writes).toEqual([]);
});

it('opens the design.md of a plan with tikk edit --design and no field flags', async () => {
  const plan = makeTicket('demo-3467', {
    frontMatter: { ...makeTicket('demo-3467').frontMatter, kind: 'plan' },
  });

  const designPath = '/store/tickets/demo/demo-3467/design.md';

  const { fakeEffects, result } = edit(
    ['demo-3467', '--design'],
    false,
    { tickets: [plan] },
    {
      files: { [designPath]: '# Design\n' },
    },
  );

  successOf(await result);

  expect(fakeEffects.editorPaths).toEqual([designPath]);
});

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
  ['a done instruction', ['demo-3467', '--hash', 'h', '--status', 'done'], true],
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
  const { result } = edit(['demo-3467', '--hash', 'h', '--status', 'done'], true);

  const reason = failureOf(await result);

  expect(reason.code).toBe('invalidArguments');
  expect(reason.message).toContain('done');
});

it('returns notFound naming the ID and writes nothing for an unknown ticket', async () => {
  const { fakeSession, result } = edit(['demo-3469', '--hash', 'h', '--title', 'New'], true);
  const reason = failureOf(await result);

  expect(reason.code).toBe('notFound');
  expect(reason.message).toContain('demo-3469');
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
  const fakeSession = makeSession({ tickets: [parent, target] });
  const fakeEffects = makeEffects({ session: fakeSession });
  const lockStore = fakeSession.session.lockStore;

  const changed = makeTicket('demo-3467', {
    hash: 'hash-changed',
    frontMatter: target.frontMatter,
  });

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

it('prints the derived state of a done instruction in the text after an edit', async () => {
  const { result } = edit(['demo-3467', '--hash', 'hash-demo-3467', '--title', 'New'], false, {
    facts: [
      makeFact({ kind: 'log', type: 'submitted', text: '', item: '5ab0000000a1' }),
      makeFact({ kind: 'accept', item: '5ab0000000a1' }),
    ],
  });

  const output = successOf(await result);

  expect(output.text).toContain('demo-3467  done');
});

it('turns a task into a slice under a plan and keeps its ID and path', async () => {
  const task = makeKindTicket('demo-3467', 'task');
  const plan = makeKindTicket('demo-3468', 'plan');

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'slice', '--parent', 'demo-3468', ...criteriaArgs],
    true,
    { tickets: [task, plan] },
    criteriaFiles,
  );

  expect(successOf(await result).json).toMatchObject({ id: 'demo-3467', path: task.path });
  expect(fakeSession.writes).toHaveLength(1);
  expect(fakeSession.writes[0]?.path).toBe(task.path);
  expect(fakeSession.writes[0]?.text).toContain('kind: slice');
  expect(fakeSession.writes[0]?.text).toContain('parent: demo-3468');
  expect(fakeSession.appends).toEqual([]);
});

it('refuses to promote a task under a plan it blocks and writes nothing', async () => {
  const task = makeKindTicket('demo-3467', 'task');
  const basePlan = makeKindTicket('demo-3468', 'plan');

  const plan = makeTicket('demo-3468', {
    frontMatter: { ...basePlan.frontMatter, blockedBy: [task.id] },
  });

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'slice', '--parent', 'demo-3468', ...criteriaArgs],
    true,
    { tickets: [task, plan] },
    criteriaFiles,
  );

  const failure = failureOf(await result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('demo-3468');
  expect(fakeSession.writes).toEqual([]);
});

it('turns a task into a plan', async () => {
  const task = makeKindTicket('demo-3467', 'task');

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'plan', ...criteriaArgs],
    true,
    { tickets: [task] },
    criteriaFiles,
  );

  successOf(await result);
  expect(fakeSession.writes[0]?.text).toContain('kind: plan');
});

it('promotes a loose task to a slice under a plan and keeps its ID, body, and links', async () => {
  const plan = makeKindTicket('demo-3468', 'plan');
  const blocker = makeKindTicket('demo-3469', 'task');
  const source = makeKindTicket('demo-3473', 'task');
  const related = makeKindTicket('demo-3474', 'task');
  const loose = makeKindTicket('demo-3467', 'task');

  const task = {
    ...loose,
    frontMatter: {
      ...loose.frontMatter,
      blockedBy: [blocker.id],
      discoveredFrom: [source.id],
      related: [related.id],
    },
  };

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'slice', '--parent', 'demo-3468', ...criteriaArgs],
    true,
    { tickets: [plan, blocker, source, related, task] },
    criteriaFiles,
  );

  expect(successOf(await result).json).toMatchObject({ id: 'demo-3467', path: task.path });

  const written = parseTicketFile(fakeSession.writes[0]?.text ?? '');

  expect(written.ok && written.value.frontMatter).toMatchObject({
    kind: 'slice',
    parent: 'demo-3468',
    blockedBy: ['demo-3469'],
    discoveredFrom: ['demo-3473'],
    related: ['demo-3474'],
  });

  expect(written.ok && written.value.body).toBe(task.body);
});

it('drops new when a loose task is promoted', async () => {
  const plan = makeKindTicket('demo-3468', 'plan');
  const loose = makeKindTicket('demo-3467', 'task');
  const task = { ...loose, frontMatter: { ...loose.frontMatter, new: true } };

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'slice', '--parent', 'demo-3468', ...criteriaArgs],
    true,
    { tickets: [plan, task] },
    criteriaFiles,
  );

  successOf(await result);
  expect(fakeSession.writes[0]?.text).not.toContain('new');
});

it('refuses to promote a task with a parent and writes nothing', async () => {
  const plan = makeKindTicket('demo-3468', 'plan');
  const loose = makeKindTicket('demo-3467', 'task');
  const child = { ...loose, frontMatter: { ...loose.frontMatter, parent: plan.id } };

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'slice', '--parent', 'demo-3468', ...criteriaArgs],
    true,
    { tickets: [plan, child] },
    criteriaFiles,
  );

  expect(failureOf(await result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses to promote a done task and names its status', async () => {
  const plan = makeKindTicket('demo-3468', 'plan');
  const done = makeKindTicket('demo-3467', 'task', 'done');

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'slice', '--parent', 'demo-3468', ...criteriaArgs],
    true,
    { tickets: [plan, done] },
    criteriaFiles,
  );

  expect(failureOf(await result).message).toContain('done');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses to turn an open task into a slice without criteria and writes nothing', async () => {
  const task = makeKindTicket('demo-3467', 'task');

  const { fakeSession, result } = edit(['demo-3467', '--hash', 'h', '--kind', 'slice'], true, {
    tickets: [task],
  });

  expect(failureOf(await result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
});

it('turns an open task into a slice with the criteria of --criteria-file', async () => {
  const task = makeKindTicket('demo-3467', 'task');

  const { fakeSession, fakeEffects, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'slice', ...criteriaArgs],
    true,
    { tickets: [task] },
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
  const task = makeKindTicket('demo-3467', 'task');

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'slice', ...criteriaArgs],
    true,
    { tickets: [task] },
  );

  expect(failureOf(await result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses --kind on an instruction and writes nothing', async () => {
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
  const task = makeKindTicket('demo-3467', 'task');

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'instruction'],
    true,
    {
      tickets: [task],
    },
  );

  expect(failureOf(await result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses --parent without --kind slice', async () => {
  const task = makeKindTicket('demo-3467', 'task');
  const plan = makeKindTicket('demo-3468', 'plan');

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'plan', '--parent', 'demo-3468'],
    true,
    { tickets: [task, plan] },
  );

  expect(failureOf(await result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses a parent that is not a plan and writes nothing', async () => {
  const task = makeKindTicket('demo-3467', 'task');
  const other = makeKindTicket('demo-3468', 'task');

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'slice', '--parent', 'demo-3468', ...criteriaArgs],
    true,
    { tickets: [task, other] },
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

const criteriaSlice = makeTicket('demo-3468', {
  frontMatter: { ...makeTicket('demo-3468').frontMatter, kind: 'slice', criteria: [criterion] },
});

const criteriaInstruction = makeTicket('demo-3467', {
  frontMatter: { ...target.frontMatter, parent: criteriaSlice.id },
});

const criteriaTickets: SessionOptions = { tickets: [criteriaSlice, criteriaInstruction] };

it('refuses a covers name that the parent does not have and writes nothing', async () => {
  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--covers', 'missing'],
    true,
    criteriaTickets,
  );

  const reason = failureOf(await result);

  expect(reason.code).toBe('invalidArguments');
  expect(reason.message).toContain('missing');
  expect(fakeSession.writes).toEqual([]);
});

it('writes the covers list of an instruction whose names the parent has', async () => {
  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--covers', 'works'],
    true,
    criteriaTickets,
  );

  successOf(await result);

  expect(fakeSession.writes[0]?.text).toContain('covers:');
  expect(fakeSession.writes[0]?.text).toContain('works');
});

// The tree check reads the parent first, so only a later read can reach the covers check.
const parentReadFailsAfterFirstRead = (): SessionOptions => {
  let parentReads = 0;

  return {
    ...criteriaTickets,
    overrides: {
      getTicket: (id) => {
        if (id === criteriaInstruction.id) {
          return { ok: true, value: criteriaInstruction };
        }

        parentReads += 1;

        if (parentReads === 1) {
          return { ok: true, value: criteriaSlice };
        }

        return { ok: false, reason: { kind: 'failed', message: 'The cache is busy.' } };
      },
    },
  };
};

it('reports a storeError when the covers parent cannot be read again and writes nothing', async () => {
  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--covers', 'works'],
    true,
    parentReadFailsAfterFirstRead(),
  );

  expect(failureOf(await result)).toMatchObject({
    code: 'storeError',
    message: 'The cache is busy.',
  });

  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.appends).toEqual([]);
});

const otherCriterion = { id: 'other', check: 'bun test', expected: 'It also passes.' };

const twoCriteriaSlice = makeTicket('demo-3468', {
  frontMatter: { ...criteriaSlice.frontMatter, criteria: [criterion, otherCriterion] },
});

const coveringInstruction = makeTicket('demo-3467', {
  frontMatter: { ...criteriaInstruction.frontMatter, covers: ['works'] },
});

const coveringTickets: SessionOptions = { tickets: [twoCriteriaSlice, coveringInstruction] };

const writtenCovers = (text: string | undefined): string[] | undefined => {
  const parsed = parseTicketFile(text ?? '');

  return parsed.ok ? parsed.value.frontMatter.covers : ['unparsed'];
};

it('replaces a stored covers list with the given one', async () => {
  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--covers', 'other'],
    true,
    coveringTickets,
  );

  successOf(await result);

  expect(writtenCovers(fakeSession.writes[0]?.text)).toEqual(['other']);
});

it('keeps the stored covers when an edit changes only the title', async () => {
  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--title', 'Renamed'],
    true,
    coveringTickets,
  );

  successOf(await result);

  expect(writtenCovers(fakeSession.writes[0]?.text)).toEqual(['works']);
});

it('removes the stored covers with --clear-covers', async () => {
  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--clear-covers'],
    true,
    coveringTickets,
  );

  successOf(await result);

  expect(writtenCovers(fakeSession.writes[0]?.text)).toBeUndefined();
});

it('refuses --covers together with --clear-covers and writes nothing', async () => {
  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--covers', 'works', '--clear-covers'],
    true,
    criteriaTickets,
  );

  expect(failureOf(await result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses to move an instruction to another slice with --parent and writes nothing', async () => {
  const otherSlice = makeKindTicket('demo-3476', 'slice');

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--parent', 'demo-3476'],
    true,
    {
      tickets: [parent, target, otherSlice],
    },
  );

  expect(failureOf(await result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses a --parent that is not a valid ID with invalidArguments and writes nothing', async () => {
  const task = makeKindTicket('demo-3467', 'task');

  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--kind', 'slice', '--parent', 'Not An ID', ...criteriaArgs],
    true,
    { tickets: [task] },
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

it('keeps new on a loose open task that is only retitled', async () => {
  const loose = makeKindTicket('demo-3467', 'task');
  const task = { ...loose, frontMatter: { ...loose.frontMatter, new: true } };

  const { fakeSession, result } = edit(['demo-3467', '--hash', 'h', '--title', 'New'], true, {
    tickets: [task],
  });

  successOf(await result);
  expect(fakeSession.writes[0]?.text).toContain('new: true');
});

it('drops new when an edit marks the task done', async () => {
  const loose = makeKindTicket('demo-3467', 'task');
  const task = { ...loose, frontMatter: { ...loose.frontMatter, new: true } };

  const { fakeSession, result } = edit(['demo-3467', '--hash', 'h', '--status', 'done'], true, {
    tickets: [task],
  });

  successOf(await result);
  expect(fakeSession.writes[0]?.text).not.toContain('new');
});

it('refuses to promote a done task even when the same edit sets its status to open', async () => {
  const plan = makeKindTicket('demo-3468', 'plan');
  const done = makeKindTicket('demo-3467', 'task', 'done');

  const { fakeSession, result } = edit(
    [
      'demo-3467',
      '--hash',
      'h',
      '--kind',
      'slice',
      '--parent',
      'demo-3468',
      '--status',
      'open',
      ...criteriaArgs,
    ],
    true,
    { tickets: [plan, done] },
    criteriaFiles,
  );

  expect(failureOf(await result).message).toContain('done');
  expect(fakeSession.writes).toEqual([]);
});
