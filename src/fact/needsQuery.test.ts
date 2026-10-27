import { describe, expect, it } from 'bun:test';

import { selectNeeds } from './fact.ts';
import { makeFact, makeTicket, now, instructionId } from './factHarness.ts';

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

const ask = (item: string, at: string) =>
  makeFact('3467', { kind: 'log', type: 'question', text: item, item, at });

const submit = (item: string) =>
  makeFact('3467', { kind: 'log', type: 'submitted', text: '', item });

describe('selectNeeds', () => {
  it('lists a question that was not passed up only after 30 minutes', () => {
    const ticket = makeTicket('3467');

    const question = makeFact('3467', {
      kind: 'log',
      type: 'question',
      text: 'Which one?',
      item: '0123456789ab',
      at: '2026-10-20T11:00:00.000Z',
    });

    const at29 = new Date('2026-10-20T11:29:59.000Z');
    const at30 = new Date('2026-10-20T11:30:00.000Z');
    const at31 = new Date('2026-10-20T11:31:00.000Z');

    expect(selectNeeds([ticket], [question], at29)).toEqual([]);
    expect(selectNeeds([ticket], [question], at30)).toHaveLength(1);

    expect(selectNeeds([ticket], [question], at31)).toMatchObject([
      { reason: 'question', item: '0123456789ab', passedUp: false },
    ]);
  });

  it('lists a passed-up question at once and drops it after its answer', () => {
    const ticket = makeTicket('3467');

    const question = makeFact('3467', {
      kind: 'log',
      type: 'question',
      text: 'Which one?',
      item: '0000000000a1',
      at: '2026-10-20T11:59:00.000Z',
    });

    const passUp = makeFact('3467', { kind: 'passUp', item: '0000000000a1' });

    const answer = makeFact('3467', {
      kind: 'log',
      type: 'answer',
      text: 'This',
      item: '0000000000a1',
    });

    expect(selectNeeds([ticket], [question, passUp], now)).toMatchObject([
      { reason: 'question', item: '0000000000a1', passedUp: true, ageSeconds: 60 },
    ]);

    expect(selectNeeds([ticket], [question, passUp, answer], now)).toEqual([]);
  });

  it('lists each open question of an instruction, and not one whose answer names it', () => {
    const ticket = makeTicket('3467');

    const facts = [
      ask('0000000000a1', '2026-10-20T08:00:00.000Z'),
      ask('0000000000a2', '2026-10-20T09:00:00.000Z'),
      ask('0000000000a3', '2026-10-20T10:00:00.000Z'),
      makeFact('3467', { kind: 'log', type: 'answer', text: 'b', item: '0000000000a2' }),
    ];

    expect(selectNeeds([ticket], facts, now).map((item) => [item.since, item.ageSeconds])).toEqual([
      ['2026-10-20T08:00:00.000Z', 14_400],
      ['2026-10-20T10:00:00.000Z', 7200],
    ]);
  });

  it('lists a submission only after its pass-up, from its submit time, until it is accepted', () => {
    const ticket = makeTicket('3467');

    const submitted = makeFact('3467', {
      kind: 'log',
      type: 'submitted',
      text: '',
      item: '5ab0000000a1',
      at: '2026-10-20T11:30:00.000Z',
    });

    const passUp = makeFact('3467', { kind: 'passUp', item: '5ab0000000a1' });

    expect(selectNeeds([ticket], [submitted], now)).toEqual([]);

    expect(selectNeeds([ticket], [submitted, passUp], now)).toMatchObject([
      {
        reason: 'submitted',
        item: '5ab0000000a1',
        passedUp: true,
        since: '2026-10-20T11:30:00.000Z',
        ageSeconds: 1800,
      },
    ]);

    const accept = makeFact('3467', { kind: 'accept', item: '5ab0000000a1' });

    expect(selectNeeds([ticket], [submitted, passUp, accept], now)).toEqual([]);
  });

  it('does not list a new submission because an earlier one was passed up', () => {
    const ticket = makeTicket('3467');

    const facts = [
      submit('5ab0000000a1'),
      makeFact('3467', { kind: 'passUp', item: '5ab0000000a1' }),
      makeFact('3467', { kind: 'reject', item: '5ab0000000a1', reason: 'No.' }),
      submit('5ab0000000b1'),
    ];

    expect(selectNeeds([ticket], facts, now)).toEqual([]);
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
      makeFact('3469', { kind: 'log', type: 'submitted', text: '', item: '5ab0000000a1' }),
      makeFact('3469', { kind: 'passUp', item: '5ab0000000a1' }),
    ];

    expect(reasonsOf(selectNeeds(tickets, facts, now))).toEqual([
      [instructionId('3469'), 'submitted'],
    ]);
  });

  it('orders items oldest first, then by ticket ID, and allows several items per instruction', () => {
    const tickets = [makeTicket('3478'), makeTicket('3468'), makeTicket('3469')];
    const at = '2026-10-20T10:00:00.000Z';
    const question = { kind: 'log', type: 'question', text: '', item: '0000000000a1' };

    const facts = [
      makeFact('3478', { ...question, at }),
      makeFact('3469', { ...question, at }),
      makeFact('3468', { ...question, at: '2026-10-20T11:00:00.000Z' }),
      makeFact('3478', {
        kind: 'log',
        type: 'submitted',
        text: '',
        item: '5ab0000000a1',
        at: '2026-10-20T09:00:00.000Z',
      }),
      makeFact('3478', { kind: 'passUp', item: '5ab0000000a1' }),
    ];

    expect(reasonsOf(selectNeeds(tickets, facts, now))).toEqual([
      [instructionId('3478'), 'submitted'],
      [instructionId('3469'), 'question'],
      [instructionId('3478'), 'question'],
      [instructionId('3468'), 'question'],
    ]);
  });

  it('clamps a negative age to zero', () => {
    const future = makeFact('3467', {
      kind: 'log',
      type: 'question',
      text: '',
      item: '0000000000a1',
      at: '2026-10-20T13:00:00.000Z',
    });

    const passUp = makeFact('3467', { kind: 'passUp', item: '0000000000a1' });

    expect(selectNeeds([makeTicket('3467')], [future, passUp], now)[0]?.ageSeconds).toBe(0);
  });

  it('lists nothing for archived, canceled, draft, done, and task tickets', () => {
    const tickets = [
      makeTicket('3467', { archived: '2026-10-01' }),
      makeTicket('3468', { status: 'canceled' }),
      makeTicket('3469', { status: 'draft' }),
      makeTicket('3478'),
      makeTicket('3479', { kind: 'task' }),
    ];

    const question = { kind: 'log', type: 'question', text: '', item: '0000000000a1' };

    const facts = [
      ...['3467', '3468', '3469', '3478', '3479'].map((id) => makeFact(id, question)),
      makeFact('3478', { kind: 'accept', item: '5ab0000000a1' }),
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

  it('lists a merged slice with an open instruction as flagged with that instruction', () => {
    const instruction = makeTicket('3478', { parent: '3469' });
    const items = selectNeeds([slice, instruction], [merged, audit], now);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reason: 'flagged', openInstructions: [instruction.id] });
  });

  it('still flags a merged slice whose open instruction is archived', () => {
    const instruction = makeTicket('3478', { parent: '3469', archived: '2026-10-01' });
    const items = selectNeeds([slice, instruction], [merged, audit], now);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reason: 'flagged', openInstructions: [instruction.id] });
  });

  it('does not flag a merged slice because of an archived canceled instruction', () => {
    const instruction = makeTicket('3478', {
      parent: '3469',
      archived: '2026-10-01',
      status: 'canceled',
    });

    expect(selectNeeds([slice, instruction], [merged, audit], now)).toEqual([]);
  });

  it('leaves out a done slice', () => {
    expect(selectNeeds([slice], [merged, audit], now)).toEqual([]);
  });
});
