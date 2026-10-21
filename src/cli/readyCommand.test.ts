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
} from './cliHarness.ts';
import { readyCommand } from './readyCommand.ts';

const taskWith = (id: string, fields: Partial<CliTicket['frontMatter']>): CliTicket => {
  const base = makeTicket(id);

  return makeTicket(id, { frontMatter: { ...base.frontMatter, ...fields } });
};

const ready = (args: string[], tickets: CliTicket[], facts: Fact[] = []) => {
  const fakeSession = makeSession({ tickets, facts });
  const { effects } = makeEffects({ session: fakeSession });

  return readyCommand({ args, json: true, effects, session: fakeSession.session });
};

it('lists open tasks as candidates and names the blockers of a skipped task', async () => {
  const blocked = taskWith('demo-3467', { rank: 1, blockedBy: [ticketIdOf('demo-3468')] });
  const blocker = taskWith('demo-3468', { rank: 2, title: 'Blocker' });
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
  });

  expect(output.json).not.toHaveProperty('candidates.0.body');
  expect(output.text).toContain('skipped: demo-3467  blocked');
});

it('names the holder and lease end of a skipped active task', async () => {
  const active = taskWith('demo-3467', { rank: 1 });
  const open = taskWith('demo-3468', { rank: 2 });

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
  const blocked = taskWith('demo-3467', { blockedBy: [ticketIdOf('demo-3468')] });
  const archived = taskWith('demo-3468', { status: 'canceled', archived: '2026-10-01' });
  const output = successOf(await ready([], [blocked, archived]));

  expect(output.json).toMatchObject({ candidates: [{ id: 'demo-3467' }], skipped: [] });
});

it('limits candidates to a project and a parent', async () => {
  const other = taskWith('other-3467', { project: projectNameOf('other') });
  const child = taskWith('demo-3467', { parent: ticketIdOf('demo-3469') });
  const loose = taskWith('demo-3468', {});
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

it('skips a task whose file does not parse and names its path', async () => {
  const broken = makeTicket('demo-3467', { error: 'Bad front matter.' });
  const open = taskWith('demo-3468', { rank: 2 });
  const output = successOf(await ready([], [broken, open]));

  expect(output.json).toMatchObject({
    candidates: [{ id: 'demo-3468' }],
    skipped: [{ id: 'demo-3467', reason: 'parseError', path: broken.path }],
  });

  expect(output.json).not.toMatchObject({ candidates: [{ id: 'demo-3467' }] });
  expect(output.text).toContain('skipped: demo-3467  parseError');
});

it('does not list a broken task outside the requested project', async () => {
  const other = taskWith('other-3467', { project: projectNameOf('other') });
  const broken = makeTicket('demo-3468', { error: 'Bad.' });
  const output = successOf(await ready(['--project', 'other'], [other, broken]));

  expect(output.json).toMatchObject({ candidates: [{ id: 'other-3467' }], skipped: [] });
});

it('lists broken tasks only inside the requested parent', async () => {
  const parent = ticketIdOf('demo-3469');
  const inside = taskWith('demo-3467', { parent });
  const outside = taskWith('demo-3468', { parent: ticketIdOf('demo-3478') });
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

it('lists neither a broken slice nor a broken archived task among the unreadable tasks', async () => {
  const brokenSlice = { ...makeKindTicket('demo-3467', 'slice'), error: 'Bad.' };
  const archived = taskWith('demo-3468', { archived: '2026-10-01' });
  const output = successOf(await ready([], [brokenSlice, { ...archived, error: 'Bad.' }]));

  expect(output.json).toEqual({ candidates: [], skipped: [] });
});

it('lists tasks for --kind task', async () => {
  const output = successOf(await ready(['--kind', 'task'], [taskWith('demo-3467', {})]));

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
  const task = taskWith('demo-3469', { parent: ticketIdOf('demo-3466') });
  const output = successOf(await ready(['--parent', 'demo-3466'], [plan, blocked, free, task]));

  expect(output.json).toMatchObject({
    candidates: [{ id: 'demo-3468' }],
    skipped: [
      { id: 'demo-3467', reason: 'blocked', blockers: [{ id: 'demo-3468', state: 'open' }] },
    ],
  });
});

it('still returns the tasks of a slice parent', async () => {
  const slice = makeKindTicket('demo-3466', 'slice');
  const task = taskWith('demo-3467', { parent: ticketIdOf('demo-3466') });
  const sibling = sliceWith('demo-3468', { parent: ticketIdOf('demo-3466') });
  const output = successOf(await ready(['--parent', 'demo-3466'], [slice, task, sibling]));

  expect(output.json).toMatchObject({ candidates: [{ id: 'demo-3467' }], skipped: [] });
});

it('selects every slice with --kind slice and refuses --kind together with --parent', async () => {
  const slice = sliceWith('demo-3467', {});
  const task = taskWith('demo-3468', {});
  const output = successOf(await ready(['--kind', 'slice'], [slice, task]));
  const both = failureOf(await ready(['--kind', 'slice', '--parent', 'demo-3467'], [slice]));
  const unknown = failureOf(await ready(['--kind', 'plan'], [slice]));

  expect(output.json).toMatchObject({ candidates: [{ id: 'demo-3467' }] });
  expect(both.code).toBe('invalidArguments');
  expect(unknown.code).toBe('invalidArguments');
});

it('fails for a missing parent and for a task or issue parent', async () => {
  const task = taskWith('demo-3467', {});
  const issue = makeKindTicket('demo-3468', 'issue');
  const missing = failureOf(await ready(['--parent', 'demo-3499'], [task]));
  const taskParent = failureOf(await ready(['--parent', 'demo-3467'], [task]));
  const issueParent = failureOf(await ready(['--parent', 'demo-3468'], [issue]));

  expect(missing.code).toBe('notFound');
  expect(taskParent.code).toBe('invalidArguments');
  expect(issueParent.code).toBe('invalidArguments');
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
