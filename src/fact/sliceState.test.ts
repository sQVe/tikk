import { describe, expect, it } from 'bun:test';

import {
  buildSliceIndex,
  criterionFingerprint,
  deriveShownSliceState,
  deriveSliceState,
} from './fact.ts';
import type { Fact } from './fact.ts';
import { makeFact, makeTicket, now, instructionId } from './factHarness.ts';

const slice = makeTicket('3469', { kind: 'slice' });
const instruction = makeTicket('3478', { parent: '3469' });

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
    repository: 'sqve/tikk',
    changeHash: 'hash1',
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

describe('deriveShownSliceState', () => {
  const claim = makeFact('3478', {
    kind: 'claim',
    holder: 'agent',
    leaseEnd: '2026-10-20T13:00:00.000Z',
    at: '2026-10-20T11:00:00.000Z',
  });

  it('shows a draft slice its stored status, even when an instruction has started', () => {
    const draft = makeTicket('3469', { kind: 'slice', status: 'draft' });
    const index = buildSliceIndex([draft, instruction], [claim]);

    expect(deriveShownSliceState(draft, index, now).state).toBe('draft');
  });

  it('shows an open slice its derived state', () => {
    const open = makeTicket('3469', { kind: 'slice', status: 'open' });
    const index = buildSliceIndex([open, instruction], [claim]);

    expect(deriveShownSliceState(open, index, now).state).toBe('active');
  });
});

describe('deriveSliceState', () => {
  it('derives mergedUnverified from a merged PR with no audit', () => {
    const result = derive(slice, [slice], [prFact()], now);

    expect(result.state).toBe('mergedUnverified');
    expect(result.pr).toMatchObject({ number: 7, mergeCommit: 'bbb', checkedAt: prFact().at });
  });

  it('derives planned from no PR and no started instruction', () => {
    const result = derive(slice, [slice, instruction], [], now);

    expect(result).toMatchObject({ state: 'planned', since: null, ageSeconds: null, pr: null });
  });

  it('derives planned from a PR closed unmerged', () => {
    const result = derive(slice, [slice], [prFact({ state: 'closed' })], now);

    expect(result.state).toBe('planned');
  });

  it('derives active from a started instruction and dates it from the instruction claim', () => {
    const claim = makeFact('3478', {
      kind: 'claim',
      holder: 'agent',
      leaseEnd: '2026-10-20T13:00:00.000Z',
      at: '2026-10-20T11:00:00.000Z',
    });

    const result = derive(slice, [slice, instruction], [claim], now);

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
      item: '5ab0000000a1',
      text: 'Done.',
      at: '2026-10-20T11:00:00.000Z',
    });

    const progress = makeFact('3478', {
      kind: 'log',
      type: 'progress',
      text: 'More.',
      at: '2026-10-20T11:30:00.000Z',
    });

    const result = derive(slice, [slice, instruction], [claim, submitted, progress], now);

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
      repository: 'sqve/tikk',
      changeHash: 'hash1',
      head: 'aaa',
      base: 'main',
      verdicts: [
        {
          criterion: 'works',
          verdict: 'met',
          evidence: 'Ran it.',
          definition: criterionFingerprint({ check: 'Run it.', expected: 'It works.' }),
        },
      ],
    });

    expect(derive(audited, [audited], [prFact(), audit], now).state).toBe('done');
    expect(derive(grown, [grown], [prFact(), audit], now).state).toBe('mergedUnverified');
  });

  it('derives mergedUnverified when a criterion is reworded to another criterion text', () => {
    const audited = makeTicket('3469', {
      kind: 'slice',
      criteria: [
        { id: 'first', check: 'Run it.', expected: 'It works.' },
        { id: 'second', check: 'Time it.', expected: 'It is fast.' },
      ],
    });

    const reworded = makeTicket('3469', {
      kind: 'slice',
      criteria: [
        { id: 'first', check: 'Run it.', expected: 'It works.' },
        { id: 'second', check: 'Run it.', expected: 'It works.' },
      ],
    });

    const audit = makeFact('3469', {
      kind: 'audit',
      repository: 'sqve/tikk',
      changeHash: 'hash1',
      head: 'aaa',
      base: 'main',
      verdicts: [
        {
          criterion: 'first',
          verdict: 'met',
          evidence: 'Ran it.',
          definition: criterionFingerprint({ check: 'Run it.', expected: 'It works.' }),
        },
        {
          criterion: 'second',
          verdict: 'met',
          evidence: 'Timed it.',
          definition: criterionFingerprint({ check: 'Time it.', expected: 'It is fast.' }),
        },
      ],
    });

    expect(derive(audited, [audited], [prFact(), audit], now).state).toBe('done');
    expect(derive(reworded, [reworded], [prFact(), audit], now).state).toBe('mergedUnverified');
  });

  it('derives done from an audit whose verdict fingerprints the current criterion text', () => {
    const current = makeTicket('3469', {
      kind: 'slice',
      criteria: [{ id: 'works', check: 'Run it.', expected: 'It works fast.' }],
    });

    const audit = makeFact('3469', {
      kind: 'audit',
      repository: 'sqve/tikk',
      changeHash: 'hash1',
      head: 'aaa',
      base: 'main',
      verdicts: [
        {
          criterion: 'works',
          verdict: 'met',
          evidence: 'Ran it.',
          definition: criterionFingerprint({ check: 'Run it.', expected: 'It works fast.' }),
        },
      ],
    });

    expect(derive(current, [current], [prFact(), audit], now).state).toBe('done');
  });

  it('derives mergedUnverified from a verdict whose fingerprint is for an older criterion text', () => {
    const current = makeTicket('3469', {
      kind: 'slice',
      criteria: [{ id: 'works', check: 'Run it.', expected: 'It works fast.' }],
    });

    const audit = makeFact('3469', {
      kind: 'audit',
      repository: 'sqve/tikk',
      changeHash: 'hash1',
      head: 'aaa',
      base: 'main',
      verdicts: [
        {
          criterion: 'works',
          verdict: 'met',
          evidence: 'Ran it.',
          definition: criterionFingerprint({ check: 'Run it.', expected: 'It works.' }),
        },
      ],
    });

    expect(derive(current, [current], [prFact(), audit], now).state).toBe('mergedUnverified');
  });

  it('derives mergedUnverified from a met verdict with no fingerprint', () => {
    const current = makeTicket('3469', {
      kind: 'slice',
      criteria: [{ id: 'works', check: 'Run it.', expected: 'It works.' }],
    });

    const audit = makeFact('3469', {
      kind: 'audit',
      repository: 'sqve/tikk',
      changeHash: 'hash1',
      head: 'aaa',
      base: 'main',
      verdicts: [{ criterion: 'works', verdict: 'met', evidence: 'Ran it.' }],
    });

    expect(derive(current, [current], [prFact(), audit], now).state).toBe('mergedUnverified');
  });

  it('derives mergedUnverified from an all-met audit for another repository with the same head', () => {
    const audit = auditFact('aaa', 'met', { repository: 'other/repo' });

    expect(derive(slice, [slice], [prFact(), audit], now).state).toBe('mergedUnverified');
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

  it('derives mergedUnverified from an audit that mixes met and not-met verdicts', () => {
    const audit = auditFact('aaa', 'met', {
      at: '2026-10-20T11:00:00.000Z',
      verdicts: [
        { criterion: 'It works.', verdict: 'met', evidence: 'Ran it.' },
        { criterion: 'extra', verdict: 'not-met', evidence: 'Failed.' },
      ],
    });

    const result = derive(slice, [slice], [prFact(), audit], now);

    expect(result.state).toBe('mergedUnverified');
  });

  it('follows the newest linked PR over a merged fact of another PR', () => {
    const other = prFact({
      number: 8,
      state: 'open',
      mergeCommit: undefined,
      inTrunk: false,
      at: '2026-10-20T11:00:00.000Z',
    });

    const result = derive(slice, [slice], [prFact(), other], now);

    expect(result).toMatchObject({ state: 'inReview', pr: { number: 8 } });
  });

  it('keeps a merge confirmed in trunk over a newer fact that says it is not', () => {
    const outsideTrunk = prFact({ inTrunk: false, at: '2026-10-20T11:00:00.000Z' });
    const result = derive(slice, [slice], [prFact(), outsideTrunk], now);

    expect(result.state).toBe('mergedUnverified');
  });

  it('derives flagged for a merged, audited slice with an open instruction', () => {
    const result = derive(slice, [slice, instruction], [prFact(), auditFact('aaa')], now);

    expect(result).toMatchObject({ state: 'flagged', openInstructions: [instructionId('3478')] });
  });

  it('derives done for a merged, audited slice whose instructions are done', () => {
    const submission = makeFact('3478', {
      kind: 'log',
      type: 'submitted',
      text: '',
      item: '5ab0000000a1',
    });

    const accept = makeFact('3478', { kind: 'accept', item: '5ab0000000a1' });
    const facts = [prFact(), auditFact('aaa'), submission, accept];
    const result = derive(slice, [slice, instruction], facts, now);

    expect(result).toMatchObject({ state: 'done', openInstructions: [] });
  });

  it('derives flagged for a merged, audited slice with an open task, and done once it is done', () => {
    const task = makeTicket('3479', { kind: 'task', parent: '3469' });
    const doneTask = makeTicket('3479', { kind: 'task', parent: '3469', status: 'done' });
    const facts = [prFact(), auditFact('aaa')];
    const open = derive(slice, [slice, task], facts, now);
    const finished = derive(slice, [slice, doneTask], facts, now);

    expect(open).toMatchObject({ state: 'flagged', openTasks: [instructionId('3479')] });
    expect(finished).toMatchObject({ state: 'done', openTasks: [] });
  });

  it('keeps a merged slice with an open task and no audit as mergedUnverified', () => {
    const task = makeTicket('3479', { kind: 'task', parent: '3469' });
    const result = derive(slice, [slice, task], [prFact()], now);

    expect(result).toMatchObject({ state: 'mergedUnverified', openTasks: [instructionId('3479')] });
  });
});
