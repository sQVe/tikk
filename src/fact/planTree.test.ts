import { expect, it } from 'bun:test';

import { buildPlanTree } from './fact.ts';
import { makeFact, makeTicket, now } from './factHarness.ts';

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

it('shows instructions only under the active slice, with each slice state and PR number', () => {
  const plan = makeTicket('333a', { kind: 'plan', title: 'The plan' });
  const active = makeTicket('333b', { kind: 'slice', parent: '333a', rank: 1 });
  const planned = makeTicket('333c', { kind: 'slice', parent: '333a', rank: 2 });
  const reviewed = makeTicket('333d', { kind: 'slice', parent: '333a', rank: 3 });
  const instructionA = makeTicket('333e', { parent: '333b', rank: 2 });
  const instructionB = makeTicket('333f', { parent: '333b', rank: 1 });
  const plannedInstruction = makeTicket('333g', { parent: '333c' });
  const task = makeTicket('333h', { kind: 'task' });
  const facts = [claim('333f'), prFact('333d')];

  const tree = buildPlanTree(
    [plan, active, planned, reviewed, instructionA, instructionB, plannedInstruction, task],
    facts,
    now,
  );

  expect(tree).toEqual([
    {
      plan: { id: plan.id, title: 'The plan', state: 'open' },
      slices: [
        {
          id: active.id,
          title: active.frontMatter.title,
          state: 'active',
          pr: null,
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
          instructions: [],
        },
        {
          id: reviewed.id,
          title: reviewed.frontMatter.title,
          state: 'inReview',
          pr: 42,
          instructions: [],
        },
      ],
    },
  ]);
});

it('leaves out archived and canceled tickets and groups orphan slices under no plan', () => {
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

  const tree = buildPlanTree(
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
  );

  expect(tree).toHaveLength(1);
  expect(tree[0]?.plan).toBeNull();
  expect(tree[0]?.slices.map((slice) => slice.id)).toEqual([orphan.id, ofCanceledPlan.id]);

  expect(tree[0]?.slices[0]?.instructions.map((instruction) => instruction.id)).toEqual([
    draftInstruction.id,
    startedInstruction.id,
  ]);

  expect(tree[0]?.slices[0]?.instructions.map((instruction) => instruction.state)).toEqual([
    'draft',
    'active',
  ]);
});

it('orders plans by rank with unranked last, then by id, and puts no plan at the end', () => {
  const late = makeTicket('333a', { kind: 'plan' });
  const early = makeTicket('333i', { kind: 'plan', rank: 1 });
  const orphan = makeTicket('333c', { kind: 'slice' });

  const tree = buildPlanTree([late, orphan, early], [], now);

  expect(tree.map((group) => group.plan?.id ?? null)).toEqual([early.id, late.id, null]);
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

  const open = buildPlanTree([plan, slice, openTask], [merged, audit], now);
  const done = buildPlanTree([plan, slice, doneTask], [merged, audit], now);

  expect(open[0]?.plan?.state).toBe('open');
  expect(done[0]?.plan?.state).toBe('done');
});
