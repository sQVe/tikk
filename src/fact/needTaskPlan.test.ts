import { describe, expect, it } from 'bun:test';

import { selectNeeds } from './fact.ts';
import { instructionId, makeFact, makeTicket, now, reasonsOf } from './factHarness.ts';

describe('selectNeeds for tasks and draft plans', () => {
  const blocker = makeTicket('3464', { kind: 'task' });

  it('lists an open task once as blockingTask, naming each unfinished ticket it blocks', () => {
    const first = makeTicket('3466', { blockedBy: ['3464'] });
    const second = makeTicket('3468', { blockedBy: ['3464'] });

    const items = selectNeeds([blocker, first, second], [], now);

    expect(items).toMatchObject([
      {
        ticket: { id: instructionId('3464') },
        reason: 'blockingTask',
        blocks: [first.id, second.id],
      },
    ]);
  });

  it('does not count a blocked ticket that is done, canceled, or archived', () => {
    const tickets = [
      blocker,
      makeTicket('3466', { blockedBy: ['3464'], status: 'done', kind: 'task' }),
      makeTicket('3468', { blockedBy: ['3464'], status: 'canceled' }),
      makeTicket('3469', { blockedBy: ['3464'], archived: '2026-10-01' }),
    ];

    expect(selectNeeds(tickets, [], now)).toEqual([]);
  });

  it('dates a blocking task from its latest status fact, and has no date without one', () => {
    const first = makeTicket('3466', { blockedBy: ['3464'] });
    const undated = selectNeeds([blocker, first], [], now);

    const statuses = [
      makeFact('3464', { kind: 'status', status: 'open', at: '2026-10-20T08:00:00.000Z' }),
      makeFact('3464', { kind: 'status', status: 'open', at: '2026-10-20T09:00:00.000Z' }),
    ];

    const dated = selectNeeds([blocker, first], statuses, now);

    expect(undated).toMatchObject([{ since: null, ageSeconds: null }]);
    expect(dated).toMatchObject([{ since: '2026-10-20T09:00:00.000Z', ageSeconds: 10_800 }]);
  });

  it('does not list a task that only an accepted instruction blocks', () => {
    const accepted = makeTicket('3466', { blockedBy: ['3464'] });

    const submission = makeFact('3466', {
      kind: 'log',
      type: 'submitted',
      text: '',
      item: '5ab0000000a1',
    });

    const accept = makeFact('3466', { kind: 'accept', item: '5ab0000000a1' });

    expect(selectNeeds([blocker, accepted], [submission, accept], now)).toEqual([]);
  });

  it('names only the open instruction in blocks when another instruction is accepted', () => {
    const accepted = makeTicket('3466', { blockedBy: ['3464'] });
    const open = makeTicket('3468', { blockedBy: ['3464'] });

    const submission = makeFact('3466', {
      kind: 'log',
      type: 'submitted',
      text: '',
      item: '5ab0000000a1',
    });

    const accept = makeFact('3466', { kind: 'accept', item: '5ab0000000a1' });

    expect(selectNeeds([blocker, accepted, open], [submission, accept], now)).toMatchObject([
      { ticket: { id: instructionId('3464') }, reason: 'blockingTask', blocks: [open.id] },
    ]);
  });

  it('lists a done blocking task as nothing', () => {
    const done = makeTicket('3464', { kind: 'task', status: 'done' });
    const first = makeTicket('3466', { blockedBy: ['3464'] });

    expect(selectNeeds([done, first], [], now)).toEqual([]);
  });

  it('lists a loose new task as newTask', () => {
    const loose = makeTicket('3464', { kind: 'task', new: true });

    expect(reasonsOf(selectNeeds([loose], [], now))).toEqual([[loose.id, 'newTask']]);
  });

  it('lists a draft plan only while its latest waiting fact is true', () => {
    const plan = makeTicket('3476', { kind: 'plan', status: 'draft' });

    const waiting = makeFact('3476', {
      kind: 'waiting',
      waiting: true,
      text: 'Pick a name',
      at: '2026-10-20T09:00:00.000Z',
    });

    const resumed = makeFact('3476', {
      kind: 'waiting',
      waiting: false,
      at: '2026-10-20T09:30:00.000Z',
    });

    expect(selectNeeds([plan], [], now)).toEqual([]);

    expect(selectNeeds([plan], [waiting], now)).toMatchObject([
      { reason: 'draftPlan', text: 'Pick a name', since: '2026-10-20T09:00:00.000Z' },
    ]);

    expect(selectNeeds([plan], [waiting, resumed], now)).toEqual([]);
  });

  it('drops a draft plan that is no longer a draft', () => {
    const plan = makeTicket('3476', { kind: 'plan', status: 'open', criteria: [] });

    const waiting = makeFact('3476', {
      kind: 'waiting',
      waiting: true,
      at: '2026-10-20T09:00:00.000Z',
    });

    expect(selectNeeds([plan], [waiting], now)).toEqual([]);
  });

  it('lists an item with no date after the dated items', () => {
    const loose = makeTicket('3464', { kind: 'task', new: true });

    const question = makeFact('3478', {
      kind: 'log',
      type: 'question',
      text: '',
      item: '0000000000a1',
      at: '2026-10-20T11:00:00.000Z',
    });

    const passUp = makeFact('3478', { kind: 'passUp', item: '0000000000a1' });

    expect(reasonsOf(selectNeeds([loose, makeTicket('3478')], [question, passUp], now))).toEqual([
      [instructionId('3478'), 'question'],
      [loose.id, 'newTask'],
    ]);
  });
});
