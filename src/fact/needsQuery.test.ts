import { describe, expect, it } from 'bun:test';

import { selectNeeds } from './fact.ts';
import { makeFact, makeTicket, now, taskId } from './factHarness.ts';

const reasonsOf = (items: ReturnType<typeof selectNeeds>) =>
  items.map((item) => [item.ticket.id, item.reason]);

const reviewOf = (id: string, fingerprints: string[]) =>
  makeFact(id, {
    kind: 'review',
    target: { repository: 'r', head: 'a', base: 'main', changeHash: 'c' },
    captureHash: 'h',
    mode: 'm',
    findings: fingerprints.map((fingerprint) => ({
      fingerprint,
      severity: 'high',
      location: 'f',
      claim: `Claim ${fingerprint}`,
    })),
  });

const statusOf = (id: string, fingerprint: string, status: string, at: string) =>
  makeFact(id, { kind: 'finding', fingerprint, status, actor: 'a', reason: 'r', at });

describe('selectNeeds', () => {
  it('lists an unanswered question and drops it after an answer', () => {
    const ticket = makeTicket('3467');
    const question = makeFact('3467', { kind: 'log', type: 'question', text: 'Which one?' });

    const answer = makeFact('3467', {
      kind: 'log',
      type: 'answer',
      text: 'This one',
      at: '2026-10-20T11:00:00.000Z',
    });

    expect(reasonsOf(selectNeeds([ticket], [question], now))).toEqual([
      [taskId('3467'), 'question'],
    ]);

    expect(selectNeeds([ticket], [question, answer], now)).toEqual([]);
  });

  it('dates a question from the oldest one without an answer after it', () => {
    const ticket = makeTicket('3467');

    const facts = [
      makeFact('3467', {
        kind: 'log',
        type: 'question',
        text: 'a',
        at: '2026-10-20T08:00:00.000Z',
      }),
      makeFact('3467', { kind: 'log', type: 'answer', text: 'b', at: '2026-10-20T09:00:00.000Z' }),
      makeFact('3467', {
        kind: 'log',
        type: 'question',
        text: 'c',
        at: '2026-10-20T10:00:00.000Z',
      }),
      makeFact('3467', {
        kind: 'log',
        type: 'question',
        text: 'd',
        at: '2026-10-20T11:00:00.000Z',
      }),
    ];

    const [item] = selectNeeds([ticket], facts, now);

    expect(item?.since).toBe('2026-10-20T10:00:00.000Z');
    expect(item?.ageSeconds).toBe(7200);
  });

  it('lists a submitted task from its submit time until it is accepted', () => {
    const ticket = makeTicket('3467');

    const submitted = makeFact('3467', {
      kind: 'log',
      type: 'submitted',
      text: '',
      at: '2026-10-20T11:30:00.000Z',
    });

    const [item] = selectNeeds([ticket], [submitted], now);

    expect(item?.reason).toBe('submitted');
    expect(item?.since).toBe('2026-10-20T11:30:00.000Z');
    expect(item?.ageSeconds).toBe(1800);

    const accept = makeFact('3467', { kind: 'accept' });

    expect(selectNeeds([ticket], [submitted, accept], now)).toEqual([]);
  });

  it('lists a claim whose lease ended, from the lease end, with its holder', () => {
    const ticket = makeTicket('3467');

    const claim = makeFact('3467', {
      kind: 'claim',
      holder: 'agent',
      leaseEnd: '2026-10-20T11:59:15.000Z',
    });

    const [item] = selectNeeds([ticket], [claim], now);

    expect(item).toMatchObject({
      reason: 'staleClaim',
      since: '2026-10-20T11:59:15.000Z',
      ageSeconds: 45,
      holder: 'agent',
    });
  });

  it('ignores a live lease, a released claim, and a claim followed by a submit', () => {
    const live = makeFact('3467', {
      kind: 'claim',
      holder: 'a',
      leaseEnd: '2026-10-20T13:00:00.000Z',
    });

    const ended = { kind: 'claim', holder: 'a', leaseEnd: '2026-10-20T11:00:00.000Z' };

    const tickets = [makeTicket('3467'), makeTicket('3468'), makeTicket('3469')];

    const facts = [
      live,
      makeFact('3468', ended),
      makeFact('3468', { kind: 'release', holder: 'a' }),
      makeFact('3469', ended),
      makeFact('3469', { kind: 'log', type: 'submitted', text: '' }),
    ];

    expect(reasonsOf(selectNeeds(tickets, facts, now))).toEqual([[taskId('3469'), 'submitted']]);
  });

  it('orders items oldest first, then by ticket ID, and allows several items per task', () => {
    const tickets = [makeTicket('3478'), makeTicket('3468'), makeTicket('3469')];
    const at = '2026-10-20T10:00:00.000Z';

    const facts = [
      makeFact('3478', { kind: 'log', type: 'question', text: '', at }),
      makeFact('3469', { kind: 'log', type: 'question', text: '', at }),
      makeFact('3468', { kind: 'log', type: 'question', text: '', at: '2026-10-20T11:00:00.000Z' }),
      makeFact('3478', {
        kind: 'log',
        type: 'submitted',
        text: '',
        at: '2026-10-20T09:00:00.000Z',
      }),
    ];

    expect(reasonsOf(selectNeeds(tickets, facts, now))).toEqual([
      [taskId('3478'), 'submitted'],
      [taskId('3469'), 'question'],
      [taskId('3478'), 'question'],
      [taskId('3468'), 'question'],
    ]);
  });

  it('clamps a negative age to zero', () => {
    const future = makeFact('3467', {
      kind: 'log',
      type: 'question',
      text: '',
      at: '2026-10-20T13:00:00.000Z',
    });

    expect(selectNeeds([makeTicket('3467')], [future], now)[0]?.ageSeconds).toBe(0);
  });

  it('lists nothing for archived, canceled, draft, done, and issue tickets', () => {
    const tickets = [
      makeTicket('3467', { archived: '2026-10-01' }),
      makeTicket('3468', { status: 'canceled' }),
      makeTicket('3469', { status: 'draft' }),
      makeTicket('3478'),
      makeTicket('3479', { kind: 'issue' }),
    ];

    const question = { kind: 'log', type: 'question', text: '' };

    const facts = [
      ...['3467', '3468', '3469', '3478', '3479'].map((id) => makeFact(id, question)),
      makeFact('3478', { kind: 'accept' }),
    ];

    expect(selectNeeds(tickets, facts, now)).toEqual([]);
  });

  it('lists a blocked finding on a slice and drops it after a fixed status', () => {
    const slice = makeTicket('3467', { kind: 'slice' });
    const target = { repository: 'r', head: 'a', base: 'main', changeHash: 'c' };

    const review = makeFact('3467', {
      kind: 'review',
      target,
      captureHash: 'h',
      mode: 'm',
      findings: [{ fingerprint: 'fp', severity: 'high', location: 'f', claim: 'Broken' }],
    });

    const blocked = makeFact('3467', {
      kind: 'finding',
      fingerprint: 'fp',
      status: 'blocked',
      actor: 'a',
      reason: 'r',
      at: '2026-10-20T11:00:00.000Z',
    });

    const fixed = makeFact('3467', {
      kind: 'finding',
      fingerprint: 'fp',
      status: 'fixed',
      actor: 'a',
      reason: 'r',
      at: '2026-10-20T11:30:00.000Z',
    });

    const [item] = selectNeeds([slice], [review, blocked], now);

    expect(item).toMatchObject({
      reason: 'blockedFinding',
      since: '2026-10-20T11:00:00.000Z',
      fingerprint: 'fp',
      claim: 'Broken',
    });

    expect(selectNeeds([slice], [review, blocked, fixed], now)).toEqual([]);
  });

  it('lists no blocked finding of an archived ticket', () => {
    const slice = makeTicket('3467', { kind: 'slice', archived: '2026-10-01' });

    const facts = [
      reviewOf('3467', ['fp']),
      statusOf('3467', 'fp', 'blocked', '2026-10-20T11:00:00.000Z'),
    ];

    expect(selectNeeds([slice], facts, now)).toEqual([]);
  });

  it('dates a blocked finding from its own status, not from another finding', () => {
    const slice = makeTicket('3467', { kind: 'slice' });

    const facts = [
      reviewOf('3467', ['fp-1', 'fp-2']),
      statusOf('3467', 'fp-1', 'blocked', '2026-10-20T11:00:00.000Z'),
      statusOf('3467', 'fp-2', 'fixed', '2026-10-20T11:30:00.000Z'),
    ];

    const items = selectNeeds([slice], facts, now);

    expect(items.map((item) => [item.reason, item.since])).toEqual([
      ['blockedFinding', '2026-10-20T11:00:00.000Z'],
    ]);
  });
});

describe('selectNeeds for slices', () => {
  const slice = makeTicket('3469', { kind: 'slice' });

  const merged = makeFact('3469', {
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

  const audit = makeFact('3469', {
    kind: 'audit',
    repository: 'sqve/tikk',
    changeHash: 'hash1',
    head: 'aaa',
    base: 'main',
    verdicts: [{ criterion: 'It works.', verdict: 'met', evidence: 'Ran it.' }],
  });

  it('lists a merged slice with no audit as mergedUnverified, dated from the PR fact', () => {
    const [item, ...rest] = selectNeeds([slice], [merged], now);

    expect(rest).toEqual([]);

    expect(item).toMatchObject({
      reason: 'mergedUnverified',
      since: '2026-10-20T10:00:00.000Z',
      ageSeconds: 7200,
    });
  });

  it('lists a merged slice with an open task as flagged with that task', () => {
    const task = makeTicket('3478', { parent: '3469' });
    const items = selectNeeds([slice, task], [merged, audit], now);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reason: 'flagged', openTasks: [task.id] });
  });

  it('still flags a merged slice whose open task is archived', () => {
    const task = makeTicket('3478', { parent: '3469', archived: '2026-10-01' });
    const items = selectNeeds([slice, task], [merged, audit], now);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reason: 'flagged', openTasks: [task.id] });
  });

  it('does not flag a merged slice because of an archived canceled task', () => {
    const task = makeTicket('3478', { parent: '3469', archived: '2026-10-01', status: 'canceled' });

    expect(selectNeeds([slice, task], [merged, audit], now)).toEqual([]);
  });

  it('leaves out a done slice', () => {
    expect(selectNeeds([slice], [merged, audit], now)).toEqual([]);
  });
});
