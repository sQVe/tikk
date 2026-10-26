import { expect, it } from 'bun:test';

import {
  failureOf,
  makeEffects,
  makeSession,
  makeTicket,
  projectNameOf,
  successOf,
} from './cliHarness.ts';
import type { SessionOptions } from './cliHarness.ts';
import { ticketList } from './ticketList.ts';

const other = makeTicket('other-3467', {
  frontMatter: {
    kind: 'task',
    title: 'Other title',
    project: projectNameOf('other'),
    blockedBy: [],
    discoveredFrom: [],
    related: [],
    status: 'open',
  },
});

const archived = makeTicket('demo-3468', {
  frontMatter: {
    kind: 'instruction',
    title: 'Old',
    project: projectNameOf('demo'),
    blockedBy: [],
    discoveredFrom: [],
    related: [],
    status: 'open',
    archived: '2026-01-01',
  },
});

const list = (args: string[], options: SessionOptions = {}) => {
  const fake = makeSession({
    tickets: [makeTicket('demo-3467'), other, archived],
    ...options,
  });

  const { effects } = makeEffects();

  return { fake, result: ticketList({ args, json: false, effects, session: fake.session }) };
};

const idsOf = (json: unknown): string[] =>
  (json as { tickets: { id: string }[] }).tickets.map((ticket) => ticket.id);

it('lists unarchived tickets without bodies', () => {
  const { fake, result } = list([]);
  const output = successOf(result);

  expect(idsOf(output.json)).toEqual(['demo-3467', 'other-3467']);
  expect(output.json).toMatchObject({ errors: [] });
  expect(JSON.stringify(output.json)).not.toContain('"body"');
  expect(fake.listOptions).toEqual([{ includeArchived: false }]);
});

it('formats one text line per ticket', () => {
  const output = successOf(list([]).result);

  expect(output.text).toBe(
    'demo-3467  instruction  open  A title\nother-3467  task  open  Other title\n',
  );
});

it('includes archived tickets with --archived', () => {
  const { fake, result } = list(['--archived']);

  expect(idsOf(successOf(result).json)).toEqual(['demo-3467', 'other-3467', 'demo-3468']);
  expect(fake.listOptions).toEqual([{ includeArchived: true }]);
});

it('filters by project', () => {
  const output = successOf(list(['--project', 'other']).result);

  expect(idsOf(output.json)).toEqual(['other-3467']);
  expect(output.text).not.toContain('demo-3467');
});

it('reports cached errors in json and text', () => {
  const errors = [{ path: '/store/demo/bad.md', message: 'Broken.' }];
  const output = successOf(list([], { errors }).result);

  expect(output.json).toMatchObject({ errors });
  expect(output.text).toContain('/store/demo/bad.md');
  expect(output.text).toContain('Broken');
});

it('refuses positionals with a usage message', () => {
  const reason = failureOf(list(['demo-3467']).result);

  expect(reason.code).toBe('invalidArguments');
  expect(reason.message).toContain('tikk ls');
});

it('refuses unknown options', () => {
  expect(failureOf(list(['--bogus']).result).code).toBe('invalidArguments');
});
