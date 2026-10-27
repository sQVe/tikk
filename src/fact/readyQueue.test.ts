import { describe, expect, it } from 'bun:test';

import { selectReady } from './fact.ts';
import { makeFact, makeTicket, now, instructionId } from './factHarness.ts';

const noScope = {};

describe('selectReady', () => {
  it('skips an instruction blocked by an open instruction and names the blocker', () => {
    const blocker = makeTicket('3469', { rank: 3 });
    const blocked = makeTicket('3478', { rank: 1, blockedBy: ['3469'] });
    const free = makeTicket('3479', { rank: 2 });
    const result = selectReady([blocked, free, blocker], [], now, noScope);

    expect(result.candidates.map((entry) => entry.ticket.id)).toEqual([free.id, blocker.id]);

    expect(result.skipped).toEqual([
      {
        ticket: blocked,
        reason: 'blocked',
        blockers: [{ id: instructionId('3469'), state: 'open' }],
      },
    ]);
  });

  it('does not let a canceled blocker block', () => {
    const blocker = makeTicket('3469', { status: 'canceled' });
    const instruction = makeTicket('3478', { blockedBy: ['3469'] });
    const result = selectReady([blocker, instruction], [], now, noScope);

    expect(result.candidates.map((entry) => entry.ticket.id)).toEqual([instruction.id]);
    expect(result.skipped).toEqual([]);
  });

  it('does not let an accepted instruction or a done task block', () => {
    const accepted = makeTicket('3469');
    const task = makeTicket('3478', { kind: 'task', status: 'done' });
    const instruction = makeTicket('3479', { blockedBy: ['3469', '3478'] });
    const facts = [makeFact('3469', { kind: 'accept', item: '5ab0000000a1' })];
    const result = selectReady([accepted, task, instruction], facts, now, noScope);

    expect(result.candidates.map((entry) => entry.ticket.id)).toEqual([instruction.id]);
  });

  it('blocks on a missing blocker and names it as missing', () => {
    const instruction = makeTicket('3478', { blockedBy: ['3469'] });
    const result = selectReady([instruction], [], now, noScope);

    expect(result.candidates).toEqual([]);

    expect(result.skipped).toEqual([
      {
        ticket: instruction,
        reason: 'blocked',
        blockers: [{ id: instructionId('3469'), state: 'missing' }],
      },
    ]);
  });

  it('skips an active instruction with its holder and lease end', () => {
    const active = makeTicket('3469', { rank: 1 });
    const free = makeTicket('3478', { rank: 2 });

    const facts = [
      makeFact('3469', { kind: 'claim', holder: 'agent', leaseEnd: '2026-10-20T13:00:00.000Z' }),
    ];

    const result = selectReady([free, active], facts, now, noScope);

    expect(result.candidates.map((entry) => entry.ticket.id)).toEqual([free.id]);

    expect(result.skipped).toEqual([
      { ticket: active, reason: 'active', holder: 'agent', leaseEnd: '2026-10-20T13:00:00.000Z' },
    ]);
  });

  it('skips a submitted instruction and omits skipped instructions after the last candidate', () => {
    const submitted = makeTicket('3469', { rank: 1 });
    const free = makeTicket('3478', { rank: 2 });
    const later = makeTicket('3479', { rank: 3, blockedBy: ['3469'] });

    const facts = [
      makeFact('3469', { kind: 'log', type: 'submitted', item: '5ab0000000a1', text: 'done' }),
    ];

    const result = selectReady([submitted, free, later], facts, now, noScope);

    expect(result.skipped.map((entry) => entry.reason)).toEqual(['submitted']);
    expect(result.candidates.map((entry) => entry.ticket.id)).toEqual([free.id]);
  });

  it('lists every considered instruction as skipped when there is no candidate', () => {
    const submitted = makeTicket('3469');
    const blocked = makeTicket('3478', { blockedBy: ['3469'] });

    const facts = [
      makeFact('3469', { kind: 'log', type: 'submitted', item: '5ab0000000a1', text: 'done' }),
    ];

    const result = selectReady([submitted, blocked], facts, now, noScope);

    expect(result.candidates).toEqual([]);
    expect(result.skipped.map((entry) => entry.reason)).toEqual(['submitted', 'blocked']);
  });

  it('orders ranked instructions first, then by ID, and ignores drafts, tasks, and archived instructions', () => {
    const unranked = makeTicket('3469');
    const ranked = makeTicket('3478', { rank: 5 });
    const draft = makeTicket('3479', { status: 'draft', rank: 0 });
    const task = makeTicket('3489', { kind: 'task', rank: 0 });
    const archived = makeTicket('3498', { archived: '2026-01-01', rank: 0 });
    const result = selectReady([unranked, archived, task, draft, ranked], [], now, noScope);

    expect(result.candidates.map((entry) => entry.ticket.id)).toEqual([ranked.id, unranked.id]);
  });

  it('limits candidates to the project and the direct children of the parent', () => {
    const parent = makeTicket('3469');
    const child = makeTicket('3478', { parent: '3469' });
    const grandchild = makeTicket('3479', { parent: '3478' });
    const other = makeTicket('3489');
    const tickets = [parent, child, grandchild, other];
    const byParent = selectReady(tickets, [], now, { parent: parent.id });
    const byOtherProject = selectReady(tickets, [], now, { project: 'other' });

    expect(byParent.candidates.map((entry) => entry.ticket.id)).toEqual([child.id]);
    expect(byOtherProject.candidates).toEqual([]);
  });

  it('selects slices of a plan and treats a canceled slice blocker as cleared', () => {
    const plan = makeTicket('3469', { kind: 'plan' });
    const canceled = makeTicket('3478', { kind: 'slice', parent: '3469', status: 'canceled' });
    const slice = makeTicket('3479', { kind: 'slice', parent: '3469', blockedBy: ['3478'] });
    const instruction = makeTicket('3489', { parent: '3469' });
    const scope = { kind: 'slice' as const, parent: plan.id };
    const result = selectReady([plan, canceled, slice, instruction], [], now, scope);

    expect(result.candidates.map((entry) => entry.ticket.id)).toEqual([slice.id]);
    expect(result.skipped).toEqual([]);
  });

  it('never selects a draft slice and lets an open or draft slice block', () => {
    const draft = makeTicket('3478', { kind: 'slice', parent: '3469', status: 'draft', rank: 1 });
    const open = makeTicket('3479', { kind: 'slice', parent: '3469', rank: 3 });

    const blocked = makeTicket('3489', {
      kind: 'slice',
      parent: '3469',
      rank: 2,
      blockedBy: ['3478'],
    });

    const scope = { kind: 'slice' as const, parent: instructionId('3469') };
    const result = selectReady([draft, open, blocked], [], now, scope);

    expect(result.candidates.map((entry) => entry.ticket.id)).toEqual([open.id]);

    expect(result.skipped).toEqual([
      { ticket: blocked, reason: 'blocked', blockers: [{ id: draft.id, state: 'draft' }] },
    ]);
  });
});

const prFor = (suffix: string, extra: Record<string, unknown>) =>
  makeFact(suffix, {
    kind: 'pr',
    repository: 'sqve/tikk',
    number: 7,
    state: 'open',
    base: 'main',
    head: 'aaa',
    trunk: 'main',
    inTrunk: false,
    ...extra,
  });

describe('selectReady for slices', () => {
  const sliceScope = { kind: 'slice' } as const;

  it('reports a planned slice as a candidate with its derived state', () => {
    const slice = makeTicket('3469', { kind: 'slice' });
    const result = selectReady([slice], [], now, sliceScope);

    expect(result.candidates).toEqual([{ ticket: slice, state: 'planned' }]);
  });

  it('does not offer a slice that is in review', () => {
    const slice = makeTicket('3469', { kind: 'slice' });
    const result = selectReady([slice], [prFor('3469', {})], now, sliceScope);

    expect(result.candidates).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('offers a slice blocked by a done slice', () => {
    const done = makeTicket('3469', { kind: 'slice' });
    const blocked = makeTicket('3478', { kind: 'slice', blockedBy: ['3469'] });

    const facts = [
      prFor('3469', { state: 'merged', inTrunk: true, mergeCommit: 'bbb' }),
      makeFact('3469', {
        kind: 'audit',
        repository: 'sqve/tikk',
        changeHash: 'hash1',
        head: 'aaa',
        base: 'main',
        verdicts: [{ criterion: 'It works.', verdict: 'met', evidence: 'Ran it.' }],
      }),
    ];

    const result = selectReady([done, blocked], facts, now, sliceScope);

    expect(result.candidates.map((entry) => entry.ticket.id)).toEqual([blocked.id]);
  });

  it('keeps a slice blocked by a slice in review and names its state', () => {
    const review = makeTicket('3469', { kind: 'slice' });
    const blocked = makeTicket('3478', { kind: 'slice', blockedBy: ['3469'] });
    const facts = [prFor('3469', { state: 'merged', mergeCommit: 'aaa' })];
    const result = selectReady([review, blocked], facts, now, sliceScope);

    expect(result.candidates).toEqual([]);

    expect(result.skipped).toEqual([
      { ticket: blocked, reason: 'blocked', blockers: [{ id: review.id, state: 'inReview' }] },
    ]);
  });
});

describe('selectReady blockers that flow down and stack', () => {
  const sliceScope = { kind: 'slice' } as const;

  it('clears a slice blocker with an open PR for the instructions of the slice', () => {
    const blockingSlice = makeTicket('3469', { kind: 'slice' });
    const slice = makeTicket('3478', { kind: 'slice', blockedBy: ['3469'] });
    const instruction = makeTicket('3479', { parent: '3478' });
    const facts = [prFor('3469', {})];
    const result = selectReady([blockingSlice, slice, instruction], facts, now, noScope);

    expect(result.candidates.map((entry) => entry.ticket.id)).toEqual([instruction.id]);
    expect(result.skipped).toEqual([]);
  });

  it('names a blocker once, from the closest level that names it, without a via for its own level', () => {
    const plan = makeTicket('3466', { kind: 'plan', blockedBy: ['3469'] });
    const slice = makeTicket('3478', { kind: 'slice', parent: '3466', blockedBy: ['3469'] });
    const instruction = makeTicket('3479', { parent: '3478', blockedBy: ['3469'] });
    const task = makeTicket('3469', { kind: 'task' });
    const result = selectReady([plan, slice, instruction, task], [], now, noScope);

    // toStrictEqual also fails on a via key that is present but undefined.
    expect(result.skipped).toStrictEqual([
      { ticket: instruction, reason: 'blocked', blockers: [{ id: task.id, state: 'open' }] },
    ]);
  });

  it('lists the stack parents of a ready slice in blockedBy order and leaves the key out when there are none', () => {
    const first = makeTicket('3469', { kind: 'slice' });
    const second = makeTicket('3478', { kind: 'slice' });
    const stacked = makeTicket('3489', { kind: 'slice', blockedBy: ['3478', '3469'] });
    const free = makeTicket('3499', { kind: 'slice' });

    const facts = [prFor('3469', { number: 7 }), prFor('3478', { number: 8 })];
    const result = selectReady([first, second, stacked, free], facts, now, sliceScope);
    const byId = new Map(result.candidates.map((entry) => [entry.ticket.id, entry]));

    expect(byId.get(stacked.id)).toMatchObject({
      stackParents: [
        { id: second.id, repository: 'sqve/tikk', number: 8 },
        { id: first.id, repository: 'sqve/tikk', number: 7 },
      ],
    });

    expect(byId.get(free.id)).not.toHaveProperty('stackParents');
  });

  it('keeps a plan blocker on a slice even when that blocking slice has an open PR', () => {
    const plan = makeTicket('3466', { kind: 'plan', blockedBy: ['3469'] });
    const blockingSlice = makeTicket('3469', { kind: 'slice' });
    const slice = makeTicket('3478', { kind: 'slice', parent: '3466' });
    const result = selectReady([plan, blockingSlice, slice], [prFor('3469', {})], now, sliceScope);

    expect(result.candidates).toEqual([]);

    expect(result.skipped).toEqual([
      {
        ticket: slice,
        reason: 'blocked',
        blockers: [{ id: blockingSlice.id, state: 'inReview', via: plan.id }],
      },
    ]);
  });
});

it('blocks the instructions of a slice whose slice blocker has no PR and names the slice as the source', () => {
  const blockingSlice = makeTicket('3469', { kind: 'slice' });
  const slice = makeTicket('3478', { kind: 'slice', blockedBy: ['3469'] });
  const instruction = makeTicket('3479', { parent: '3478' });
  const result = selectReady([blockingSlice, slice, instruction], [], now, noScope);

  expect(result.candidates).toEqual([]);

  expect(result.skipped).toEqual([
    {
      ticket: instruction,
      reason: 'blocked',
      blockers: [{ id: blockingSlice.id, state: 'planned', via: slice.id }],
    },
  ]);
});
