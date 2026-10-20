import { expect, it } from 'bun:test';

import type { Fact } from '../fact/fact.ts';
import {
  failureOf,
  makeEffects,
  makeFact,
  makeSession,
  makeTicket,
  projectNameOf,
  successOf,
} from './cliHarness.ts';
import { ticketShow } from './ticketShow.ts';

const show = (args: string[], tickets = [makeTicket('demo-3467')], facts: Fact[] = []) => {
  const { session } = makeSession({ tickets, facts });
  const { effects } = makeEffects();

  return ticketShow({ args, json: false, effects, session });
};

it('shows a ticket as json with its body and as text', () => {
  const output = successOf(show(['demo-3467']));

  expect(output.json).toMatchObject({ id: 'demo-3467', title: 'A title', body: 'A body\n' });
  expect(output.text).toContain('demo-3467');
  expect(output.text).toContain('A body');
});

it('refuses a missing ID with a usage message', () => {
  const reason = failureOf(show([]));

  expect(reason.code).toBe('invalidArguments');
  expect(reason.message).toContain('tikk show');
});

it('refuses extra positionals', () => {
  expect(failureOf(show(['demo-3467', 'demo-3468'])).code).toBe('invalidArguments');
});

it('refuses unknown options', () => {
  expect(failureOf(show(['demo-3467', '--bogus'])).code).toBe('invalidArguments');
});

it('returns notFound with the ID for an unknown ticket', () => {
  const reason = failureOf(show(['demo-3468']));

  expect(reason.code).toBe('notFound');
  expect(reason.message).toContain('demo-3468');
});

it('shows the state of a task and its claim while the claim is active', () => {
  const claim = makeFact({ kind: 'claim', holder: 'agent', leaseEnd: '2026-10-20T13:00:00.000Z' });
  const open = successOf(show(['demo-3467']));
  const active = successOf(show(['demo-3467'], [makeTicket('demo-3467')], [claim]));

  expect(open.json).toMatchObject({ state: 'open', claim: null });

  expect(active.json).toMatchObject({
    state: 'active',
    claim: {
      holder: 'agent',
      leaseEnd: '2026-10-20T13:00:00.000Z',
      session: null,
      sessionLog: null,
    },
  });
});

it('shows no state for an issue', () => {
  const issue = makeTicket('demo-3467', {
    frontMatter: {
      kind: 'issue',
      title: 'An issue',
      project: projectNameOf('demo'),
      blockedBy: [],
      status: 'closed',
    },
  });

  const output = successOf(show(['demo-3467'], [issue]));

  expect(output.json).not.toHaveProperty('state');
  expect(output.json).not.toHaveProperty('claim');
});
