import { describe, expect, it } from 'bun:test';

import { buildSliceIndex, derivePlanState } from './fact.ts';
import type { Fact } from './fact.ts';
import { makeFact, makeTicket, now } from './factHarness.ts';

const plan = makeTicket('344a', { kind: 'plan' });
const slice = makeTicket('344b', { kind: 'slice', parent: '344a' });

const mergedPr = makeFact('344b', {
  kind: 'pr',
  repository: 'sqve/tikk',
  number: 7,
  state: 'merged',
  base: 'main',
  head: 'aaa',
  mergeCommit: 'bbb',
  trunk: 'main',
  inTrunk: true,
});

const metAudit = makeFact('344b', {
  kind: 'audit',
  repository: 'sqve/tikk',
  changeHash: 'hash1',
  head: 'aaa',
  base: 'main',
  verdicts: [{ criterion: 'It works.', verdict: 'met', evidence: 'Ran it.' }],
});

const doneSliceFacts: Fact[] = [mergedPr, metAudit];

const derive = (
  target: Parameters<typeof derivePlanState>[0],
  tickets: Parameters<typeof buildSliceIndex>[0],
  facts: Fact[],
) => derivePlanState(target, buildSliceIndex(tickets, facts), now);

describe('derivePlanState', () => {
  it('keeps a plan with an open direct task open after its slices are done, until the task is done', () => {
    const task = makeTicket('344c', { kind: 'task', parent: '344a' });
    const doneTask = makeTicket('344c', { kind: 'task', parent: '344a', status: 'done' });

    expect(derive(plan, [plan, slice, task], doneSliceFacts)).toBe('open');
    expect(derive(plan, [plan, slice, doneTask], doneSliceFacts)).toBe('done');
  });

  it('keeps a plan open while a slice that is not canceled is not done', () => {
    const canceled = makeTicket('344d', { kind: 'slice', parent: '344a', status: 'canceled' });
    const pending = makeTicket('344e', { kind: 'slice', parent: '344a' });

    expect(derive(plan, [plan, slice, canceled], doneSliceFacts)).toBe('done');
    expect(derive(plan, [plan, slice, pending], doneSliceFacts)).toBe('open');
  });

  it('keeps a plan with no work that is not canceled open', () => {
    const canceledTask = makeTicket('344c', { kind: 'task', parent: '344a', status: 'canceled' });

    expect(derive(plan, [plan], [])).toBe('open');
    expect(derive(plan, [plan, canceledTask], [])).toBe('open');
  });

  it('derives done for a plan whose only work is a done direct task', () => {
    const doneTask = makeTicket('344c', { kind: 'task', parent: '344a', status: 'done' });

    expect(derive(plan, [plan, doneTask], [])).toBe('done');
  });

  it('counts an archived open task as unfinished', () => {
    const task = makeTicket('344c', {
      kind: 'task',
      parent: '344a',
      archived: '2026-10-01',
    });

    expect(derive(plan, [plan, slice, task], doneSliceFacts)).toBe('open');
  });

  it('keeps the stored status of a draft or canceled plan', () => {
    const draft = makeTicket('344a', { kind: 'plan', status: 'draft' });
    const canceled = makeTicket('344a', { kind: 'plan', status: 'canceled' });

    expect(derive(draft, [draft, slice], doneSliceFacts)).toBe('draft');
    expect(derive(canceled, [canceled, slice], doneSliceFacts)).toBe('canceled');
  });
});
