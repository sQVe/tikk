import { expect, it } from 'bun:test';

import { failureOf, makeEffects, makeSession, makeTicket, successOf } from './cliHarness.ts';
import { ticketShow } from './ticketShow.ts';

const show = (args: string[], tickets = [makeTicket('demo-3467')]) => {
  const { session } = makeSession({ tickets });
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
