import { afterEach, beforeEach, expect, it } from 'bun:test';

import { findArchiveDue } from '../fact/fact.ts';
import { invariant } from '../invariant.ts';
import {
  createDatabaseFixture,
  createFakeFiles,
  factPath,
  factText,
  okValueOf,
  openTestCache,
  ticketPath,
} from './cacheHarness.ts';

interface StoreTicket {
  id: string;
  kind: string;
  status: string;
  parent?: string;
  archived?: string;
}

interface StoreFact {
  ticket: string;
  at: string;
  fields: Record<string, unknown>;
}

interface Answers {
  precheck: boolean;
  rules: boolean;
}

const now = new Date('2026-10-20T12:00:00.000Z');
const tenDaysAgo = '2026-10-10T12:00:00.000Z';
const fifteenDaysAgo = '2026-10-05T12:00:00.000Z';

let databasePath = '';
let cleanup = async () => {};

beforeEach(async () => {
  ({ databasePath, cleanup } = await createDatabaseFixture());
});

afterEach(async () => {
  await cleanup();
});

const textOf = ({ kind, status, parent, archived }: StoreTicket): string => {
  const lines = ['---', `kind: ${kind}`, 'title: A title', 'project: tikk', `status: ${status}`];

  const isPlanned = kind === 'plan' || kind === 'slice';

  if (isPlanned && status === 'open') {
    lines.push('criteria:', '  - id: works', '    check: Run it.', '    expected: It works.');
  }

  if (parent !== undefined) {
    lines.push(`parent: ${parent}`);
  }

  if (archived !== undefined) {
    lines.push(`archived: ${archived}`);
  }

  return [...lines, '---', 'Body.\n'].join('\n');
};

// The pre-check answer, and whether the rules in findArchiveDue find work in the same store.
const answersFor = async (tickets: StoreTicket[], facts: StoreFact[]): Promise<Answers> => {
  const fake = createFakeFiles();

  for (const ticket of tickets) {
    fake.set(ticketPath(ticket.id), textOf(ticket));
  }

  const lines = facts.map((fact) => factText(fact.ticket, fact.fields, fact.at));

  fake.setFactFile(factPath(), lines.join(''));

  using cache = openTestCache(databasePath);

  await cache.refresh(fake.files);

  const listed = cache.listArchiveFacts();

  invariant(listed.ok, 'The archive facts must decode.');

  const due = findArchiveDue(okValueOf(cache.listTicketOutlines()), listed.value, now);
  const rules = due.archive.length > 0 || due.statusFacts.length > 0;

  return { precheck: okValueOf(cache.mayHaveArchiveWork(now)), rules };
};

const canceledPlan: StoreTicket = { id: 'tikk-3a4b', kind: 'plan', status: 'canceled' };

const canceledAt = (at: string): StoreFact => ({
  ticket: 'tikk-3a4b',
  at,
  fields: { kind: 'status', status: 'canceled' },
});

it('answers no for a root that finished 10 days ago and has its status fact', async () => {
  const answers = await answersFor([canceledPlan], [canceledAt(tenDaysAgo)]);

  expect(answers).toEqual({ precheck: false, rules: false });
});

it('answers yes for a root that finished 15 days ago', async () => {
  const answers = await answersFor([canceledPlan], [canceledAt(fifteenDaysAgo)]);

  expect(answers).toEqual({ precheck: true, rules: true });
});

it('answers yes for a finished root with no status fact for its current status', async () => {
  const doneTask = { id: 'tikk-3a4b', kind: 'task', status: 'done' };
  const answers = await answersFor([doneTask], [canceledAt(tenDaysAgo)]);

  expect(answers).toEqual({ precheck: true, rules: true });
});

const instruction = { id: 'tikk-3a4b', kind: 'instruction', status: 'open' };

const acceptedAt = (at: string): StoreFact[] => [
  {
    ticket: instruction.id,
    at,
    fields: { kind: 'log', type: 'submitted', text: '', item: '5ab0000000a1' },
  },
  { ticket: instruction.id, at, fields: { kind: 'accept', item: '5ab0000000a1' } },
];

it('answers no for a stand-alone instruction accepted 10 days ago', async () => {
  const answers = await answersFor([instruction], acceptedAt(tenDaysAgo));

  expect(answers).toEqual({ precheck: false, rules: false });
});

it('answers yes for a stand-alone instruction accepted 15 days ago', async () => {
  const answers = await answersFor([instruction], acceptedAt(fifteenDaysAgo));

  expect(answers).toEqual({ precheck: true, rules: true });
});

it('answers yes when a later stale accept names an earlier submission', async () => {
  const submitted = (at: string, item: string): StoreFact => ({
    ticket: instruction.id,
    at,
    fields: { kind: 'log', type: 'submitted', text: '', item },
  });

  const accepted = (at: string, item: string): StoreFact => ({
    ticket: instruction.id,
    at,
    fields: { kind: 'accept', item },
  });

  const facts = [
    submitted('2026-10-01T12:00:00.000Z', '5ab0000000a1'),
    submitted('2026-10-04T12:00:00.000Z', '5ab0000000a2'),
    accepted(fifteenDaysAgo, '5ab0000000a2'),
    accepted(tenDaysAgo, '5ab0000000a1'),
  ];

  expect(await answersFor([instruction], facts)).toEqual({ precheck: true, rules: true });
});

it('answers no for a due root whose tree is archived', async () => {
  const tickets = [
    { ...canceledPlan, archived: '2026-10-19' },
    { id: 'tikk-3a4c', kind: 'slice', status: 'open', parent: 'tikk-3a4b', archived: '2026-10-19' },
  ];

  expect(await answersFor(tickets, [canceledAt(fifteenDaysAgo)])).toEqual({
    precheck: false,
    rules: false,
  });
});

it('answers yes for an archived due root with a descendant that is not archived', async () => {
  const tickets = [
    { ...canceledPlan, archived: '2026-10-19' },
    { id: 'tikk-3a4c', kind: 'slice', status: 'open', parent: 'tikk-3a4b', archived: '2026-10-19' },
    { id: 'tikk-3a4d', kind: 'instruction', status: 'open', parent: 'tikk-3a4c' },
  ];

  expect(await answersFor(tickets, [canceledAt(fifteenDaysAgo)])).toEqual({
    precheck: true,
    rules: true,
  });
});

const planWithSlice = [
  canceledPlan,
  { id: 'tikk-3a4c', kind: 'slice', status: 'open', parent: 'tikk-3a4b' },
];

const unarchivedAt = (ticket: string, at: string): StoreFact => ({
  ticket,
  at,
  fields: { kind: 'unarchive' },
});

it('answers no for a due tree whose tickets were unarchived after the finish', async () => {
  const facts = [
    canceledAt(fifteenDaysAgo),
    unarchivedAt('tikk-3a4b', tenDaysAgo),
    unarchivedAt('tikk-3a4c', tenDaysAgo),
  ];

  expect(await answersFor(planWithSlice, facts)).toEqual({ precheck: false, rules: false });
});

it('answers yes for a due tree with a ticket unarchived before the finish', async () => {
  const facts = [
    unarchivedAt('tikk-3a4c', '2026-09-01T12:00:00.000Z'),
    canceledAt(fifteenDaysAgo),
    unarchivedAt('tikk-3a4b', tenDaysAgo),
  ];

  expect(await answersFor(planWithSlice, facts)).toEqual({ precheck: true, rules: true });
});

it('answers yes for a due root when only another ticket was unarchived after the finish', async () => {
  const openTask = { id: 'tikk-3a4d', kind: 'task', status: 'open' };
  const facts = [canceledAt(fifteenDaysAgo), unarchivedAt('tikk-3a4d', tenDaysAgo)];

  expect(await answersFor([canceledPlan, openTask], facts)).toEqual({
    precheck: true,
    rules: true,
  });
});

it('answers no for a store with no finished root', async () => {
  const tickets = [
    { id: 'tikk-3a4b', kind: 'plan', status: 'open' },
    { id: 'tikk-3a4c', kind: 'instruction', status: 'open' },
  ];

  expect(await answersFor(tickets, [])).toEqual({ precheck: false, rules: false });
});

it('answers yes when an alias moves the canceled status that makes a task due', async () => {
  const fake = createFakeFiles();

  fake.set(ticketPath('tikk-3a4b'), textOf({ id: 'tikk-3a4b', kind: 'task', status: 'canceled' }));
  fake.set(ticketPath('tikk-9fk4'), textOf({ id: 'tikk-9fk4', kind: 'task', status: 'open' }));

  fake.setFactFile(
    factPath('first'),
    factText('tikk-3a4b', { kind: 'status', status: 'canceled' }, '2026-10-01T12:00:00.000Z'),
  );

  fake.setFactFile(
    factPath('second'),
    factText('tikk-3a4b', { kind: 'status', status: 'canceled' }, '2026-10-18T12:00:00.000Z') +
      factText('tikk-3a4b', { kind: 'status', status: 'open' }, '2026-10-19T12:00:00.000Z'),
  );

  fake.setFactFile(
    factPath('third'),
    factText(
      'tikk-9fk4',
      {
        kind: 'alias',
        from: 'tikk-3a4b',
        movedFacts: [1, 2].map((line) => ({ path: 'second/2026-10.jsonl', line })),
      },
      '2026-10-20T11:00:00.000Z',
    ),
  );

  using cache = openTestCache(databasePath);

  await cache.refresh(fake.files);

  const archived = cache.listArchiveFacts();

  invariant(archived.ok, 'The archive facts must decode.');

  const due = findArchiveDue(cache.listTicketOutlines(), archived.value, now);
  const rules = due.archive.length > 0 || due.statusFacts.length > 0;

  expect(rules).toBe(true);

  expect({ precheck: cache.mayHaveArchiveWork(now), rules }).toEqual({
    precheck: true,
    rules: true,
  });
});
