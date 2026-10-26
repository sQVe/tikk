import { describe, expect, it } from 'bun:test';

import { deriveInstructionState } from './fact.ts';
import { makeFact, makeTicket, now } from './factHarness.ts';

const ticket = makeTicket('3469');

const liveClaim = {
  kind: 'claim',
  holder: 'agent',
  leaseEnd: '2026-10-20T13:00:00.000Z',
  session: 's1',
  sessionLog: '/tmp/log',
};

describe('deriveInstructionState', () => {
  it('is open with no facts', () => {
    expect(deriveInstructionState(ticket, [], now)).toEqual({ state: 'open', claim: null });
  });

  it('is active with the claim while the lease runs', () => {
    const result = deriveInstructionState(ticket, [makeFact('3469', liveClaim)], now);

    expect(result).toEqual({
      state: 'active',
      claim: {
        holder: 'agent',
        leaseEnd: '2026-10-20T13:00:00.000Z',
        session: 's1',
        sessionLog: '/tmp/log',
      },
    });
  });

  it('stays open when the lease ended before now', () => {
    const stale = makeFact('3469', { ...liveClaim, leaseEnd: '2026-10-20T11:59:59.000Z' });

    expect(deriveInstructionState(ticket, [stale], now)).toEqual({ state: 'open', claim: null });
  });

  it('is open after a release', () => {
    const facts = [
      makeFact('3469', liveClaim),
      makeFact('3469', { kind: 'release', holder: 'agent' }),
    ];

    expect(deriveInstructionState(ticket, facts, now).state).toBe('open');
  });

  it('is active again when a claim follows a release', () => {
    const facts = [
      makeFact('3469', { kind: 'release', holder: 'old' }),
      makeFact('3469', liveClaim),
    ];

    expect(deriveInstructionState(ticket, facts, now).state).toBe('active');
  });

  it('is submitted when a submitted log is newer than the claim', () => {
    const facts = [
      makeFact('3469', liveClaim),
      makeFact('3469', { kind: 'log', type: 'submitted', text: 'ready' }),
    ];

    expect(deriveInstructionState(ticket, facts, now)).toEqual({ state: 'submitted', claim: null });
  });

  it('is active when a claim is newer than the submitted log', () => {
    const facts = [
      makeFact('3469', { kind: 'log', type: 'submitted', text: 'ready' }),
      makeFact('3469', liveClaim),
    ];

    expect(deriveInstructionState(ticket, facts, now).state).toBe('active');
  });

  it('is submitted when a submitted log has no claim', () => {
    const facts = [makeFact('3469', { kind: 'log', type: 'submitted', text: 'ready' })];

    expect(deriveInstructionState(ticket, facts, now).state).toBe('submitted');
  });

  it('is done after an accept', () => {
    const facts = [
      makeFact('3469', { kind: 'log', type: 'submitted', text: 'ready' }),
      makeFact('3469', { kind: 'accept' }),
    ];

    expect(deriveInstructionState(ticket, facts, now).state).toBe('done');
  });

  it('ignores facts of other tickets', () => {
    expect(deriveInstructionState(ticket, [makeFact('3478', { kind: 'accept' })], now).state).toBe(
      'open',
    );
  });

  it('follows the front matter for canceled and draft instructions, even with an accept', () => {
    const accept = [makeFact('3469', { kind: 'accept' })];

    expect(
      deriveInstructionState(makeTicket('3469', { status: 'canceled' }), accept, now).state,
    ).toBe('canceled');

    expect(deriveInstructionState(makeTicket('3469', { status: 'draft' }), accept, now).state).toBe(
      'draft',
    );
  });
});
