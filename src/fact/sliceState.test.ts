import { describe, expect, it } from 'bun:test';

import { buildSliceIndex, deriveSliceState } from './fact.ts';
import type { Fact } from './fact.ts';
import { makeFact, makeTicket, now, taskId } from './factHarness.ts';

const slice = makeTicket('3469', { kind: 'slice' });
const task = makeTicket('3478', { parent: '3469' });

const prFact = (extra: Record<string, unknown> = {}): Fact =>
  makeFact('3469', {
    kind: 'pr',
    repository: 'sqve/tikk',
    number: 7,
    state: 'merged',
    base: 'main',
    head: 'aaa',
    mergeCommit: 'bbb',
    trunk: 'main',
    inTrunk: true,
    ...extra,
  });

const auditFact = (head: string, verdict = 'met', extra: Record<string, unknown> = {}): Fact =>
  makeFact('3469', {
    kind: 'audit',
    head,
    base: 'main',
    verdicts: [{ criterion: 'It works.', verdict, evidence: 'Ran it.' }],
    ...extra,
  });

const derive = (
  target: Parameters<typeof deriveSliceState>[0],
  tickets: Parameters<typeof buildSliceIndex>[0],
  facts: Parameters<typeof buildSliceIndex>[1],
  at: Date,
) => deriveSliceState(target, buildSliceIndex(tickets, facts), at);

describe('deriveSliceState', () => {
  it('derives mergedUnverified from a merged PR with no audit', () => {
    const result = derive(slice, [slice], [prFact()], now);

    expect(result.state).toBe('mergedUnverified');
    expect(result.pr).toMatchObject({ number: 7, mergeCommit: 'bbb', checkedAt: prFact().at });
  });

  it('derives planned from no PR and no started task', () => {
    const result = derive(slice, [slice, task], [], now);

    expect(result).toMatchObject({ state: 'planned', since: null, ageSeconds: null, pr: null });
  });

  it('derives planned from a PR closed unmerged', () => {
    const result = derive(slice, [slice], [prFact({ state: 'closed' })], now);

    expect(result.state).toBe('planned');
  });

  it('derives active from a started task and dates it from the task claim', () => {
    const claim = makeFact('3478', {
      kind: 'claim',
      holder: 'agent',
      leaseEnd: '2026-10-20T13:00:00.000Z',
      at: '2026-10-20T11:00:00.000Z',
    });

    const result = derive(slice, [slice, task], [claim], now);

    expect(result).toMatchObject({
      state: 'active',
      since: '2026-10-20T11:00:00.000Z',
      ageSeconds: 3600,
    });
  });

  it('dates an active slice from a submitted log and ignores other logs', () => {
    const claim = makeFact('3478', {
      kind: 'claim',
      holder: 'agent',
      leaseEnd: '2026-10-20T13:00:00.000Z',
      at: '2026-10-20T10:30:00.000Z',
    });

    const submitted = makeFact('3478', {
      kind: 'log',
      type: 'submitted',
      text: 'Done.',
      at: '2026-10-20T11:00:00.000Z',
    });

    const progress = makeFact('3478', {
      kind: 'log',
      type: 'progress',
      text: 'More.',
      at: '2026-10-20T11:30:00.000Z',
    });

    const result = derive(slice, [slice, task], [claim, submitted, progress], now);

    expect(result).toMatchObject({ state: 'active', since: '2026-10-20T11:00:00.000Z' });
  });

  it('derives inReview from an open PR', () => {
    const result = derive(slice, [slice], [prFact({ state: 'open' })], now);

    expect(result).toMatchObject({ state: 'inReview', since: prFact().at });
  });

  it('derives inReview from a PR merged into a non-trunk branch', () => {
    const stacked = prFact({ base: 'feature', inTrunk: false });

    expect(derive(slice, [slice], [stacked], now).state).toBe('inReview');
  });

  it('derives done from an audit with every verdict met for the merged head', () => {
    const audit = auditFact('aaa', 'met', { at: '2026-10-20T11:00:00.000Z' });
    const result = derive(slice, [slice], [prFact(), audit], now);

    expect(result).toMatchObject({ state: 'done', since: prFact().at });
  });

  it('derives mergedUnverified once a criterion is added after the audit', () => {
    const audited = makeTicket('3469', {
      kind: 'slice',
      criteria: [{ id: 'works', check: 'Run it.', expected: 'It works.' }],
    });

    const grown = makeTicket('3469', {
      kind: 'slice',
      criteria: [
        { id: 'works', check: 'Run it.', expected: 'It works.' },
        { id: 'fast', check: 'Time it.', expected: 'It is fast.' },
      ],
    });

    const audit = makeFact('3469', {
      kind: 'audit',
      head: 'aaa',
      base: 'main',
      verdicts: [{ criterion: 'works', verdict: 'met', evidence: 'Ran it.' }],
    });

    expect(derive(audited, [audited], [prFact(), audit], now).state).toBe('done');
    expect(derive(grown, [grown], [prFact(), audit], now).state).toBe('mergedUnverified');
  });

  it('derives mergedUnverified from an all-met audit for another head', () => {
    const result = derive(slice, [slice], [prFact(), auditFact('zzz')], now);

    expect(result.state).toBe('mergedUnverified');
  });

  it('lets a newer audit with a failing verdict undo an older all-met audit', () => {
    const older = auditFact('aaa', 'met', { at: '2026-10-20T10:30:00.000Z' });
    const newer = auditFact('aaa', 'not-met', { at: '2026-10-20T11:00:00.000Z' });

    expect(derive(slice, [slice], [prFact(), older, newer], now).state).toBe('mergedUnverified');
  });

  it('lets an older merged fact beat a newer open fact for the same PR', () => {
    const open = prFact({
      state: 'open',
      mergeCommit: undefined,
      at: '2026-10-20T11:00:00.000Z',
    });

    const result = derive(slice, [slice], [prFact(), open], now);

    expect(result.state).toBe('mergedUnverified');
  });

  it('flags a merged slice with an open task and names the task', () => {
    const result = derive(slice, [slice, task], [prFact()], now);

    expect(result).toMatchObject({ flagged: true, openTasks: [taskId('3478')] });
  });

  it('does not flag a merged slice whose tasks are done', () => {
    const accept = makeFact('3478', { kind: 'accept' });
    const result = derive(slice, [slice, task], [prFact(), accept], now);

    expect(result).toMatchObject({ flagged: false, openTasks: [] });
  });
});
