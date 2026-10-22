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

it('shows tasks only under the active slice, with each slice state and PR number', () => {
  const plan = makeTicket('333a', { kind: 'plan', title: 'The plan' });
  const active = makeTicket('333b', { kind: 'slice', parent: '333a', rank: 1 });
  const planned = makeTicket('333c', { kind: 'slice', parent: '333a', rank: 2 });
  const reviewed = makeTicket('333d', { kind: 'slice', parent: '333a', rank: 3 });
  const taskA = makeTicket('333e', { parent: '333b', rank: 2 });
  const taskB = makeTicket('333f', { parent: '333b', rank: 1 });
  const plannedTask = makeTicket('333g', { parent: '333c' });
  const issue = makeTicket('333h', { kind: 'issue' });
  const facts = [claim('333f'), prFact('333d')];

  const tree = buildPlanTree(
    [plan, active, planned, reviewed, taskA, taskB, plannedTask, issue],
    facts,
    now,
  );

  expect(tree).toEqual([
    {
      plan: { id: plan.id, title: 'The plan', status: 'open' },
      slices: [
        {
          id: active.id,
          title: active.frontMatter.title,
          state: 'active',
          pr: null,
          tasks: [
            { id: taskB.id, title: taskB.frontMatter.title, state: 'active' },
            { id: taskA.id, title: taskA.frontMatter.title, state: 'open' },
          ],
        },
        { id: planned.id, title: planned.frontMatter.title, state: 'planned', pr: null, tasks: [] },
        {
          id: reviewed.id,
          title: reviewed.frontMatter.title,
          state: 'inReview',
          pr: 42,
          tasks: [],
        },
      ],
    },
  ]);
});

it('leaves out archived and canceled tickets and groups orphan slices under no plan', () => {
  const canceledPlan = makeTicket('333a', { kind: 'plan', status: 'canceled' });

  const archivedPlan = makeTicket('333b', {
    kind: 'plan',
    status: 'closed',
    archived: '2026-10-01',
  });

  const orphan = makeTicket('333c', { kind: 'slice' });
  const ofCanceledPlan = makeTicket('333d', { kind: 'slice', parent: '333a' });
  const canceledSlice = makeTicket('333e', { kind: 'slice', status: 'canceled' });
  const canceledTask = makeTicket('333f', { parent: '333c', status: 'canceled' });
  const draftTask = makeTicket('333g', { parent: '333c', status: 'draft' });
  const startedTask = makeTicket('333k', { parent: '333c' });

  const tree = buildPlanTree(
    [
      canceledPlan,
      archivedPlan,
      orphan,
      ofCanceledPlan,
      canceledSlice,
      canceledTask,
      draftTask,
      startedTask,
    ],
    [claim('333k'), claim('333f')],
    now,
  );

  expect(tree).toHaveLength(1);
  expect(tree[0]?.plan).toBeNull();
  expect(tree[0]?.slices.map((slice) => slice.id)).toEqual([orphan.id, ofCanceledPlan.id]);
  expect(tree[0]?.slices[0]?.tasks.map((task) => task.id)).toEqual([draftTask.id, startedTask.id]);
  expect(tree[0]?.slices[0]?.tasks.map((task) => task.state)).toEqual(['draft', 'active']);
});

it('orders plans by rank with unranked last, then by id, and puts no plan at the end', () => {
  const late = makeTicket('333a', { kind: 'plan' });
  const early = makeTicket('333i', { kind: 'plan', rank: 1 });
  const orphan = makeTicket('333c', { kind: 'slice' });

  const tree = buildPlanTree([late, orphan, early], [], now);

  expect(tree.map((group) => group.plan?.id ?? null)).toEqual([early.id, late.id, null]);
});
