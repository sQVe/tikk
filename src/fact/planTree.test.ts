import { expect, it } from 'bun:test';

import { invariant } from '../invariant.ts';
import { parseProjectName } from '../ticket/ticket.ts';
import type { ProjectName } from '../ticket/ticket.ts';
import { buildProjectTree } from './fact.ts';
import { makeFact, makeTicket, now } from './factHarness.ts';

const projectName = (raw: string): ProjectName => {
  const parsed = parseProjectName(raw);

  invariant(parsed.ok, `Test project ${raw} is invalid.`);

  return parsed.value;
};

const me = projectName('me');

const claim = (suffix: string) =>
  makeFact(suffix, {
    kind: 'claim',
    holder: 'agent',
    leaseEnd: '2026-10-20T13:00:00.000Z',
  });

const prFact = (suffix: string) =>
  makeFact(suffix, {
    kind: 'pr',
    repository: 'acme/app',
    number: 42,
    state: 'open',
    base: 'main',
    head: 'head1',
    trunk: 'main',
    inTrunk: false,
  });

it('shows the instructions and tasks of every slice, with each slice state and PR number', () => {
  const plan = makeTicket('333a', { kind: 'plan', title: 'The plan' });
  const active = makeTicket('333b', { kind: 'slice', parent: '333a', rank: 1 });
  const planned = makeTicket('333c', { kind: 'slice', parent: '333a', rank: 2 });
  const reviewed = makeTicket('333d', { kind: 'slice', parent: '333a', rank: 3 });
  const instructionA = makeTicket('333e', { parent: '333b', rank: 2 });
  const instructionB = makeTicket('333f', { parent: '333b', rank: 1 });
  const plannedInstruction = makeTicket('333g', { parent: '333c', status: 'draft' });
  const sliceTask = makeTicket('333h', { kind: 'task', parent: '333d', status: 'done' });
  const facts = [claim('333f'), prFact('333d')];

  const tree = buildProjectTree(
    [plan, active, planned, reviewed, instructionA, instructionB, plannedInstruction, sliceTask],
    facts,
    now,
    me,
  );

  expect(tree.projects[0]?.plans[0]?.slices).toEqual([
    {
      id: active.id,
      title: active.frontMatter.title,
      state: 'active',
      pr: null,
      tasks: [],
      instructions: [
        { id: instructionB.id, title: instructionB.frontMatter.title, state: 'active' },
        { id: instructionA.id, title: instructionA.frontMatter.title, state: 'open' },
      ],
    },
    {
      id: planned.id,
      title: planned.frontMatter.title,
      state: 'planned',
      pr: null,
      tasks: [],
      instructions: [
        {
          id: plannedInstruction.id,
          title: plannedInstruction.frontMatter.title,
          state: 'draft',
        },
      ],
    },
    {
      id: reviewed.id,
      title: reviewed.frontMatter.title,
      state: 'inReview',
      pr: 42,
      tasks: [{ id: sliceTask.id, title: sliceTask.frontMatter.title, state: 'done' }],
      instructions: [],
    },
  ]);
});

it('puts tasks with no shown parent in the inbox, open or done, and plan tasks under the plan', () => {
  const plan = makeTicket('333a', { kind: 'plan', title: 'The plan' });
  const canceledPlan = makeTicket('333b', { kind: 'plan', status: 'canceled' });
  const planTask = makeTicket('333c', { kind: 'task', parent: '333a' });
  const loose = makeTicket('333d', { kind: 'task', rank: 2 });
  const doneLoose = makeTicket('333e', { kind: 'task', status: 'done', rank: 1 });
  const ofCanceledPlan = makeTicket('333f', { kind: 'task', parent: '333b' });
  const canceledTask = makeTicket('333g', { kind: 'task', status: 'canceled' });

  const tree = buildProjectTree(
    [plan, canceledPlan, planTask, loose, doneLoose, ofCanceledPlan, canceledTask],
    [],
    now,
    me,
  );

  expect(tree.projects[0]?.inbox.map((task) => [task.id, task.state])).toEqual([
    [doneLoose.id, 'done'],
    [loose.id, 'open'],
    [ofCanceledPlan.id, 'open'],
  ]);

  expect(tree.projects[0]?.plans.map((shown) => shown.id)).toEqual([plan.id]);
  expect(tree.projects[0]?.plans[0]?.tasks.map((task) => task.id)).toEqual([planTask.id]);
});

it('leaves out archived and canceled tickets and lists slices with no shown plan apart', () => {
  const canceledPlan = makeTicket('333a', { kind: 'plan', status: 'canceled' });

  const archivedPlan = makeTicket('333b', {
    kind: 'plan',
    status: 'done',
    archived: '2026-10-01',
  });

  const orphan = makeTicket('333c', { kind: 'slice' });
  const ofCanceledPlan = makeTicket('333d', { kind: 'slice', parent: '333a' });
  const canceledSlice = makeTicket('333e', { kind: 'slice', status: 'canceled' });
  const canceledInstruction = makeTicket('333f', { parent: '333c', status: 'canceled' });
  const draftInstruction = makeTicket('333g', { parent: '333c', status: 'draft' });
  const startedInstruction = makeTicket('333k', { parent: '333c' });

  const tree = buildProjectTree(
    [
      canceledPlan,
      archivedPlan,
      orphan,
      ofCanceledPlan,
      canceledSlice,
      canceledInstruction,
      draftInstruction,
      startedInstruction,
    ],
    [claim('333k'), claim('333f')],
    now,
    me,
  );

  const [project] = tree.projects;

  expect(project?.plans).toEqual([]);
  expect(project?.slices.map((slice) => slice.id)).toEqual([orphan.id, ofCanceledPlan.id]);

  expect(project?.slices[0]?.instructions.map((instruction) => instruction.id)).toEqual([
    draftInstruction.id,
    startedInstruction.id,
  ]);

  expect(project?.slices[0]?.instructions.map((instruction) => instruction.state)).toEqual([
    'draft',
    'active',
  ]);
});

it('orders plans by rank with unranked last, then by id', () => {
  const late = makeTicket('333a', { kind: 'plan' });
  const early = makeTicket('333i', { kind: 'plan', rank: 1 });

  const tree = buildProjectTree([late, early], [], now, me);

  expect(tree.projects[0]?.plans.map((plan) => plan.id)).toEqual([early.id, late.id]);
});

it('lists the current project first, then the others by name, and none without a shown ticket', () => {
  const alpha = projectName('alpha');
  const beta = projectName('beta');
  const gamma = projectName('gamma');
  const inGamma = makeTicket('333a', { kind: 'task', project: gamma });
  const inAlpha = makeTicket('333b', { kind: 'task', project: alpha });
  const inBeta = makeTicket('333c', { kind: 'task', project: beta });
  const archived = makeTicket('333d', { kind: 'task', status: 'done', archived: '2026-10-01' });
  const tickets = [inGamma, inAlpha, inBeta, archived];

  const withCurrent = buildProjectTree(tickets, [], now, beta);
  const withLastCurrent = buildProjectTree(tickets, [], now, gamma);
  const withoutCurrent = buildProjectTree(tickets, [], now, null);

  expect(withCurrent.current).toBe(beta);
  expect(withCurrent.projects.map((project) => project.name)).toEqual([beta, alpha, gamma]);
  expect(withCurrent.projects[0]?.inbox.map((task) => task.id)).toEqual([inBeta.id]);
  expect(withLastCurrent.projects.map((project) => project.name)).toEqual([gamma, alpha, beta]);
  expect(withoutCurrent.projects.map((project) => project.name)).toEqual([alpha, beta, gamma]);
});

it('shows a ticket under its own project when its parent is in another project', () => {
  const alpha = projectName('alpha');
  const beta = projectName('beta');
  const plan = makeTicket('333a', { kind: 'plan', project: alpha });
  const task = makeTicket('333b', { kind: 'task', parent: '333a', project: beta });
  const slice = makeTicket('333c', { kind: 'slice', parent: '333a', project: beta });

  const tree = buildProjectTree([plan, task, slice], [], now, beta);
  const [betaProject, alphaProject] = tree.projects;

  expect(betaProject?.inbox.map((entry) => entry.id)).toEqual([task.id]);
  expect(betaProject?.slices.map((entry) => entry.id)).toEqual([slice.id]);
  expect(alphaProject?.plans[0]?.tasks).toEqual([]);
  expect(alphaProject?.plans[0]?.slices).toEqual([]);
});

it('shows a plan as done once its slices are done and its direct tasks are done', () => {
  const plan = makeTicket('333a', { kind: 'plan' });
  const slice = makeTicket('333b', { kind: 'slice', parent: '333a' });
  const openTask = makeTicket('333c', { kind: 'task', parent: '333a' });
  const doneTask = makeTicket('333c', { kind: 'task', parent: '333a', status: 'done' });

  const merged = makeFact('333b', {
    kind: 'pr',
    repository: 'acme/app',
    number: 42,
    state: 'merged',
    base: 'main',
    head: 'head1',
    mergeCommit: 'merge1',
    trunk: 'main',
    inTrunk: true,
  });

  const audit = makeFact('333b', {
    kind: 'audit',
    repository: 'acme/app',
    changeHash: 'hash1',
    head: 'head1',
    base: 'main',
    verdicts: [{ criterion: 'It works.', verdict: 'met', evidence: 'Ran it.' }],
  });

  const open = buildProjectTree([plan, slice, openTask], [merged, audit], now, me);
  const done = buildProjectTree([plan, slice, doneTask], [merged, audit], now, me);

  expect(open.projects[0]?.plans[0]?.state).toBe('open');
  expect(done.projects[0]?.plans[0]?.state).toBe('done');
});
