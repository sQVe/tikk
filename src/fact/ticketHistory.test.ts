import { describe, expect, it } from 'bun:test';

import { instructionId, makeFact } from './factHarness.ts';
import { selectTicketHistory } from './ticketHistory.ts';

const question = (at: string) =>
  makeFact('3467', { kind: 'log', type: 'question', text: 'Which?', item: '0123456789ab', at });

const progress = (text: string, at: string) =>
  makeFact('3467', { kind: 'log', type: 'progress', text, at });

describe('selectTicketHistory', () => {
  it('lists the facts of one ticket newest first and leaves out other tickets', () => {
    const older = question('2026-10-20T10:00:00.000Z');
    const newer = progress('Working', '2026-10-20T11:00:00.000Z');

    const other = makeFact('9999', {
      kind: 'log',
      type: 'progress',
      text: 'Other',
      at: '2026-10-20T12:00:00.000Z',
    });

    expect(selectTicketHistory([older, other, newer], instructionId('3467'))).toEqual([
      newer,
      older,
    ]);
  });

  it('keeps facts with the same time in their input order', () => {
    const first = progress('First', '2026-10-20T11:00:00.000Z');
    const second = progress('Second', '2026-10-20T11:00:00.000Z');

    expect(selectTicketHistory([first, second], instructionId('3467'))).toEqual([first, second]);
  });

  it('keeps a fact that is not a log in time order', () => {
    const status = makeFact('3467', {
      kind: 'status',
      status: 'open',
      at: '2026-10-20T09:00:00.000Z',
    });

    const log = progress('Working', '2026-10-20T10:00:00.000Z');

    expect(selectTicketHistory([status, log], instructionId('3467'))).toEqual([log, status]);
  });

  it('returns an empty history when no fact belongs to the ticket', () => {
    expect(selectTicketHistory([], instructionId('3467'))).toEqual([]);
  });

  it('does not change the input array', () => {
    const older = question('2026-10-20T10:00:00.000Z');
    const newer = progress('Working', '2026-10-20T11:00:00.000Z');
    const input = [older, newer];

    selectTicketHistory(input, instructionId('3467'));

    expect(input).toEqual([older, newer]);
    expect(input[0]).toBe(older);
  });
});
