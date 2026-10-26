import { expect, it } from 'bun:test';

import type { Fact } from '../fact/fact.ts';
import type { CliTicket } from './cliEffects.ts';
import {
  failureOf,
  makeEffects,
  makeFact,
  makeKindTicket,
  makeSession,
  makeTicket,
  projectNameOf,
  successOf,
  ticketIdOf,
  fakeGh,
} from './cliHarness.ts';
import { readyCommand } from './readyCommand.ts';

const instructionWith = (id: string, fields: Partial<CliTicket['frontMatter']>): CliTicket => {
  const base = makeTicket(id);

  return makeTicket(id, { frontMatter: { ...base.frontMatter, ...fields } });
};

const ready = (args: string[], tickets: CliTicket[], facts: Fact[] = []) => {
  const fakeSession = makeSession({ tickets, facts });
  const { effects } = makeEffects({ session: fakeSession });

  return readyCommand({ args, json: true, effects, session: fakeSession.session });
};

it('lists open instructions as candidates and names the blockers of a skipped instruction', async () => {
  const blocked = instructionWith('demo-3467', { rank: 1, blockedBy: [ticketIdOf('demo-3468')] });
  const blocker = instructionWith('demo-3468', { rank: 2, title: 'Blocker' });
  const output = successOf(await ready([], [blocked, blocker]));

  expect(output.json).toEqual({
    candidates: [expect.objectContaining({ id: 'demo-3468', title: 'Blocker', state: 'open' })],
    skipped: [
      {
        id: 'demo-3467',
        title: 'A title',
        reason: 'blocked',
        blockers: [{ id: 'demo-3468', state: 'open' }],
      },
    ],
    reconcileProblems: [],
  });

  expect(output.json).not.toHaveProperty('candidates.0.body');
  expect(output.text).toContain('skipped: demo-3467  blocked');
});

it('names the holder and lease end of a skipped active instruction', async () => {
  const active = instructionWith('demo-3467', { rank: 1 });
  const open = instructionWith('demo-3468', { rank: 2 });

  const claim = makeFact({
    kind: 'claim',
    holder: 'agent',
    leaseEnd: '2026-10-20T13:00:00.000Z',
  });

  const output = successOf(await ready([], [active, open], [claim]));

  expect(output.json).toMatchObject({
    candidates: [{ id: 'demo-3468' }],
    skipped: [
      { id: 'demo-3467', reason: 'active', holder: 'agent', leaseEnd: '2026-10-20T13:00:00.000Z' },
    ],
  });

  const skippedLine = output.text.split('\n').find((line) => line.includes('demo-3467'));

  expect(skippedLine).toContain('agent');
  expect(skippedLine).toContain('2026-10-20T13:00:00.000Z');
});

it('treats a blocker that is archived and canceled as cleared', async () => {
  const blocked = instructionWith('demo-3467', { blockedBy: [ticketIdOf('demo-3468')] });
  const archived = instructionWith('demo-3468', { status: 'canceled', archived: '2026-10-01' });
  const output = successOf(await ready([], [blocked, archived]));

  expect(output.json).toMatchObject({ candidates: [{ id: 'demo-3467' }], skipped: [] });
});

it('limits candidates to a project and a parent', async () => {
  const other = instructionWith('other-3467', { project: projectNameOf('other') });
  const child = instructionWith('demo-3467', { parent: ticketIdOf('demo-3469') });
  const loose = instructionWith('demo-3468', {});
  const slice = makeKindTicket('demo-3469', 'slice');
  const tickets = [slice, other, child, loose];
  const byProject = successOf(await ready(['--project', 'other'], tickets));
  const byParent = successOf(await ready(['--parent', 'demo-3469'], tickets));

  expect(byProject.json).toMatchObject({ candidates: [{ id: 'other-3467' }] });
  expect(byParent.json).toMatchObject({ candidates: [{ id: 'demo-3467' }] });
});

it('refuses positionals', async () => {
  expect(failureOf(await ready(['demo-3467'], [])).code).toBe('invalidArguments');
});

it('skips an instruction whose file does not parse and names its path', async () => {
  const broken = makeTicket('demo-3467', { error: 'Bad front matter.' });
  const open = instructionWith('demo-3468', { rank: 2 });
  const output = successOf(await ready([], [broken, open]));

  expect(output.json).toMatchObject({
    candidates: [{ id: 'demo-3468' }],
    skipped: [{ id: 'demo-3467', reason: 'parseError', path: broken.path }],
  });

  expect(output.json).not.toMatchObject({ candidates: [{ id: 'demo-3467' }] });
  expect(output.text).toContain('skipped: demo-3467  parseError');
});

it('does not list a broken instruction outside the requested project', async () => {
  const other = instructionWith('other-3467', { project: projectNameOf('other') });
  const broken = makeTicket('demo-3468', { error: 'Bad.' });
  const output = successOf(await ready(['--project', 'other'], [other, broken]));

  expect(output.json).toMatchObject({ candidates: [{ id: 'other-3467' }], skipped: [] });
});

it('lists broken instructions only inside the requested parent', async () => {
  const parent = ticketIdOf('demo-3469');
  const inside = instructionWith('demo-3467', { parent });
  const outside = instructionWith('demo-3468', { parent: ticketIdOf('demo-3478') });
  const insideBroken = { ...inside, error: 'Bad.' };
  const outsideBroken = { ...outside, error: 'Bad.' };
  const slice = makeKindTicket('demo-3469', 'slice');

  const scoped = successOf(
    await ready(['--parent', 'demo-3469'], [slice, insideBroken, outsideBroken]),
  );

  const unscoped = successOf(await ready([], [insideBroken, outsideBroken]));

  expect(scoped.json).toMatchObject({
    candidates: [],
    skipped: [{ id: 'demo-3467', reason: 'parseError' }],
  });

  expect(scoped.json).toHaveProperty('skipped', [expect.objectContaining({ id: 'demo-3467' })]);

  expect(unscoped.json).toHaveProperty('skipped', [
    expect.objectContaining({ id: 'demo-3467' }),
    expect.objectContaining({ id: 'demo-3468' }),
  ]);
});

it('lists neither a broken slice nor a broken archived instruction among the unreadable instructions', async () => {
  const brokenSlice = { ...makeKindTicket('demo-3467', 'slice'), error: 'Bad.' };
  const archived = instructionWith('demo-3468', { archived: '2026-10-01' });
  const output = successOf(await ready([], [brokenSlice, { ...archived, error: 'Bad.' }]));

  expect(output.json).toEqual({ candidates: [], skipped: [], reconcileProblems: [] });
});

it('lists instructions for --kind instruction', async () => {
  const output = successOf(
    await ready(['--kind', 'instruction'], [instructionWith('demo-3467', {})]),
  );

  expect(output.json).toMatchObject({ candidates: [{ id: 'demo-3467' }] });
});

const sliceWith = (id: string, fields: Partial<CliTicket['frontMatter']>): CliTicket => {
  const base = makeKindTicket(id, 'slice');

  return makeTicket(id, { frontMatter: { ...base.frontMatter, ...fields } });
};

it('returns the unblocked slices of a plan and names what blocks a skipped slice', async () => {
  const plan = makeKindTicket('demo-3466', 'plan');

  const blocked = sliceWith('demo-3467', {
    parent: ticketIdOf('demo-3466'),
    rank: 1,
    blockedBy: [ticketIdOf('demo-3468')],
  });

  const free = sliceWith('demo-3468', { parent: ticketIdOf('demo-3466'), rank: 2 });
  const instruction = instructionWith('demo-3469', { parent: ticketIdOf('demo-3466') });

  const output = successOf(
    await ready(['--parent', 'demo-3466'], [plan, blocked, free, instruction]),
  );

  expect(output.json).toMatchObject({
    candidates: [{ id: 'demo-3468', state: 'planned' }],
    skipped: [
      { id: 'demo-3467', reason: 'blocked', blockers: [{ id: 'demo-3468', state: 'planned' }] },
    ],
  });
});

it('still returns the instructions of a slice parent', async () => {
  const slice = makeKindTicket('demo-3466', 'slice');
  const instruction = instructionWith('demo-3467', { parent: ticketIdOf('demo-3466') });
  const sibling = sliceWith('demo-3468', { parent: ticketIdOf('demo-3466') });
  const output = successOf(await ready(['--parent', 'demo-3466'], [slice, instruction, sibling]));

  expect(output.json).toMatchObject({ candidates: [{ id: 'demo-3467' }], skipped: [] });
});

it('selects every slice with --kind slice and refuses --kind together with --parent', async () => {
  const slice = sliceWith('demo-3467', {});
  const instruction = instructionWith('demo-3468', {});
  const output = successOf(await ready(['--kind', 'slice'], [slice, instruction]));
  const both = failureOf(await ready(['--kind', 'slice', '--parent', 'demo-3467'], [slice]));
  const unknown = failureOf(await ready(['--kind', 'plan'], [slice]));

  expect(output.json).toMatchObject({ candidates: [{ id: 'demo-3467' }] });
  expect(both.code).toBe('invalidArguments');
  expect(unknown.code).toBe('invalidArguments');
});

it('fails for a missing parent and for an instruction or task parent', async () => {
  const instruction = instructionWith('demo-3467', {});
  const task = makeKindTicket('demo-3468', 'task');
  const missing = failureOf(await ready(['--parent', 'demo-3499'], [instruction]));
  const instructionParent = failureOf(await ready(['--parent', 'demo-3467'], [instruction]));
  const taskParent = failureOf(await ready(['--parent', 'demo-3468'], [task]));

  expect(missing.code).toBe('notFound');
  expect(instructionParent.code).toBe('invalidArguments');
  expect(taskParent.code).toBe('invalidArguments');
});

it('reports an unreadable slice as parseError and still resolves an archived parent', async () => {
  const plan = makeKindTicket('demo-3466', 'plan');

  const archivedPlan = makeTicket('demo-3466', {
    frontMatter: { ...plan.frontMatter, archived: '2026-10-01' },
  });

  const broken = sliceWith('demo-3467', { parent: ticketIdOf('demo-3466') });
  const unreadable = { ...broken, error: 'Bad YAML.' };
  const output = successOf(await ready(['--parent', 'demo-3466'], [archivedPlan, unreadable]));

  expect(output.json).toMatchObject({
    candidates: [],
    skipped: [{ id: 'demo-3467', reason: 'parseError' }],
  });
});

const openPr = makeFact({
  kind: 'pr',
  ticket: 'demo-3469',
  repository: 'acme/app',
  number: 7,
  state: 'open',
  base: 'main',
  head: 'head1',
  trunk: 'main',
  inTrunk: false,
});

it('returns the list with one reconcile problem when gh fails', async () => {
  const fakeSession = makeSession({
    tickets: [
      makeTicket('demo-3467', { frontMatter: { ...makeTicket('demo-3467').frontMatter, rank: 1 } }),
      makeKindTicket('demo-3469', 'slice'),
    ],
    facts: [openPr],
  });

  const { effects } = makeEffects({
    session: fakeSession,
    runGh: fakeGh({ 7: { state: 'OPEN', error: 'offline' } }),
  });

  const output = successOf(
    await readyCommand({ args: [], json: true, effects, session: fakeSession.session }),
  );

  expect(output.json).toMatchObject({
    candidates: [expect.objectContaining({ id: 'demo-3467' })],
    reconcileProblems: [expect.objectContaining({ ticket: 'demo-3469', number: 7 })],
  });

  expect(output.text).toContain('problem: ');
  expect(output.text).toContain('offline');
});

it('skips an instruction blocked by an open task and names the task', async () => {
  const task = makeKindTicket('demo-3468', 'task');
  const blocked = instructionWith('demo-3467', { blockedBy: [ticketIdOf('demo-3468')] });
  const output = successOf(await ready([], [blocked, task]));

  expect(output.json).toMatchObject({
    candidates: [],
    skipped: [
      { id: 'demo-3467', reason: 'blocked', blockers: [{ id: 'demo-3468', state: 'open' }] },
    ],
  });
});

it('returns the instruction once the blocking task is done', async () => {
  const task = makeKindTicket('demo-3468', 'task', 'done');
  const blocked = instructionWith('demo-3467', { blockedBy: [ticketIdOf('demo-3468')] });
  const output = successOf(await ready([], [blocked, task]));

  expect(output.json).toMatchObject({ candidates: [{ id: 'demo-3467' }], skipped: [] });
});

const mergedPr = makeFact({
  kind: 'pr',
  ticket: 'demo-3468',
  repository: 'acme/app',
  number: 8,
  state: 'merged',
  base: 'main',
  head: 'head2',
  mergeCommit: 'merge2',
  trunk: 'main',
  inTrunk: true,
});

const metAudit = makeFact({
  kind: 'audit',
  ticket: 'demo-3468',
  repository: 'acme/app',
  changeHash: 'hash2',
  head: 'head2',
  base: 'main',
  verdicts: [{ criterion: 'It works.', verdict: 'met', evidence: 'Ran it.' }],
});

it('names a merged, audited slice with an open task as a flagged blocker', async () => {
  const merged = sliceWith('demo-3468', {});

  const task = makeTicket('demo-3469', {
    frontMatter: {
      ...makeKindTicket('demo-3469', 'task').frontMatter,
      parent: ticketIdOf('demo-3468'),
    },
  });

  const blocked = sliceWith('demo-3467', { blockedBy: [ticketIdOf('demo-3468')] });

  const output = successOf(
    await ready(['--kind', 'slice'], [merged, task, blocked], [mergedPr, metAudit]),
  );

  expect(output.json).toMatchObject({
    candidates: [],
    skipped: [
      { id: 'demo-3467', reason: 'blocked', blockers: [{ id: 'demo-3468', state: 'flagged' }] },
    ],
  });
});

it('clears a plan blocker once its slices are done and blocks while a direct task is open', async () => {
  const plan = makeKindTicket('demo-3466', 'plan');
  const merged = sliceWith('demo-3468', { parent: ticketIdOf('demo-3466') });
  const blocked = sliceWith('demo-3467', { blockedBy: [ticketIdOf('demo-3466')] });

  const task = makeTicket('demo-3469', {
    frontMatter: {
      ...makeKindTicket('demo-3469', 'task').frontMatter,
      parent: ticketIdOf('demo-3466'),
    },
  });

  const facts = [mergedPr, metAudit];
  const done = successOf(await ready(['--kind', 'slice'], [plan, merged, blocked], facts));
  const open = successOf(await ready(['--kind', 'slice'], [plan, merged, blocked, task], facts));

  expect(done.json).toMatchObject({ candidates: [{ id: 'demo-3467' }], skipped: [] });

  expect(open.json).toMatchObject({
    candidates: [],
    skipped: [
      { id: 'demo-3467', reason: 'blocked', blockers: [{ id: 'demo-3466', state: 'open' }] },
    ],
  });
});

it('skips the instructions of a blocked slice and names the slice that holds the blocker', async () => {
  const slice = sliceWith('demo-3466', { blockedBy: [ticketIdOf('demo-3469')] });
  const task = makeKindTicket('demo-3469', 'task');
  const first = instructionWith('demo-3467', { parent: ticketIdOf('demo-3466'), rank: 1 });
  const second = instructionWith('demo-3468', { parent: ticketIdOf('demo-3466'), rank: 2 });
  const output = successOf(await ready([], [slice, task, first, second]));

  expect(output.json).toMatchObject({
    candidates: [],
    skipped: [
      {
        id: 'demo-3467',
        reason: 'blocked',
        blockers: [{ id: 'demo-3469', state: 'open', via: 'demo-3466' }],
      },
      {
        id: 'demo-3468',
        reason: 'blocked',
        blockers: [{ id: 'demo-3469', state: 'open', via: 'demo-3466' }],
      },
    ],
  });

  expect(output.text).toContain('skipped: demo-3467  blocked  demo-3469 (open) via demo-3466');
});

it('lets a slice stack on a blocking slice whose PR is open and names that PR', async () => {
  const parent = sliceWith('demo-3466', {});
  const child = sliceWith('demo-3467', { blockedBy: [ticketIdOf('demo-3466')] });

  const pr = makeFact({
    kind: 'pr',
    ticket: 'demo-3466',
    repository: 'acme/app',
    number: 9,
    state: 'open',
    base: 'main',
    head: 'head9',
    trunk: 'main',
    inTrunk: false,
  });

  const output = successOf(await ready(['--kind', 'slice'], [parent, child], [pr]));

  expect(output.json).toMatchObject({
    candidates: [
      {
        id: 'demo-3467',
        stackParents: [{ id: 'demo-3466', repository: 'acme/app', number: 9 }],
      },
    ],
    skipped: [],
  });

  expect(output.text).toContain('stack on demo-3466 #9');
});

it('skips an instruction whose plan is blocked by an open task and names the plan as the source', async () => {
  const plan = makeTicket('demo-3466', {
    frontMatter: {
      ...makeKindTicket('demo-3466', 'plan').frontMatter,
      blockedBy: [ticketIdOf('demo-3469')],
    },
  });

  const slice = sliceWith('demo-3467', { parent: ticketIdOf('demo-3466') });
  const task = makeKindTicket('demo-3469', 'task');
  const instruction = instructionWith('demo-3468', { parent: ticketIdOf('demo-3467') });
  const output = successOf(await ready([], [plan, slice, task, instruction]));

  expect(output.json).toMatchObject({
    candidates: [],
    skipped: [
      {
        id: 'demo-3468',
        reason: 'blocked',
        blockers: [{ id: 'demo-3469', state: 'open', via: 'demo-3466' }],
      },
    ],
  });
});

it('keeps a slice blocked by a task even when that task has an open PR', async () => {
  const task = makeKindTicket('demo-3466', 'task');
  const blocked = sliceWith('demo-3467', { blockedBy: [ticketIdOf('demo-3466')] });

  const pr = makeFact({
    kind: 'pr',
    ticket: 'demo-3466',
    repository: 'acme/app',
    number: 9,
    state: 'open',
    base: 'main',
    head: 'head9',
    trunk: 'main',
    inTrunk: false,
  });

  const output = successOf(await ready(['--kind', 'slice'], [task, blocked], [pr]));

  expect(output.json).toMatchObject({
    candidates: [],
    skipped: [
      { id: 'demo-3467', reason: 'blocked', blockers: [{ id: 'demo-3466', state: 'open' }] },
    ],
  });
});

it('keeps an instruction blocked by its own slice blocker while that slice PR is open', async () => {
  const slice = sliceWith('demo-3466', {});
  const instruction = instructionWith('demo-3467', { blockedBy: [ticketIdOf('demo-3466')] });

  const pr = makeFact({
    kind: 'pr',
    ticket: 'demo-3466',
    repository: 'acme/app',
    number: 9,
    state: 'open',
    base: 'main',
    head: 'head9',
    trunk: 'main',
    inTrunk: false,
  });

  const output = successOf(await ready([], [slice, instruction], [pr]));

  expect(output.json).toMatchObject({
    candidates: [],
    skipped: [
      {
        id: 'demo-3467',
        reason: 'blocked',
        blockers: [{ id: 'demo-3466', state: 'inReview' }],
      },
    ],
  });
});
