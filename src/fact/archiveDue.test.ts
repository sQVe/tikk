import { expect, it } from 'bun:test';

import { invariant } from '../invariant.ts';
import { parseTicketId } from '../ticket/ticket.ts';
import type { TicketId } from '../ticket/ticket.ts';
import type { ArchiveTicket } from './archiveDue.ts';
import { findArchiveDue } from './archiveDue.ts';
import { parseFactLine } from './factLine.ts';
import type { Fact } from './factLine.ts';

const now = new Date('2026-10-20T12:00:00.000Z');
const fifteenDaysAgo = '2026-10-05T12:00:00.000Z';

const idOf = (raw: string): TicketId => {
  const parsed = parseTicketId(raw);

  invariant(parsed.ok, `Test ID ${raw} is invalid.`);

  return parsed.value;
};

const ticketOf = (
  id: string,
  frontMatter: Partial<ArchiveTicket['frontMatter']> = {},
): ArchiveTicket => ({
  id: idOf(id),
  frontMatter: { kind: 'plan', status: 'canceled', ...frontMatter },
});

const factOf = (ticket: string, at: string, fields: Record<string, unknown>): Fact => {
  const parsed = parseFactLine(
    JSON.stringify({ version: 1, ticket, at, machine: 'laptop', ...fields }),
  );

  invariant(parsed.ok, 'The test fact should parse.');

  return parsed.value;
};

const dueOf = (tickets: ArchiveTicket[], facts: Fact[]): unknown =>
  findArchiveDue(tickets, facts, now);

const archivedOf = (tickets: ArchiveTicket[], facts: Fact[]): string[] =>
  findArchiveDue(tickets, facts, now).archive;

const canceledFact = (at: string): Fact =>
  factOf('demo-3467', at, { kind: 'status', status: 'canceled' });

it('archives a finished root again when its field was removed by hand', () => {
  const due = dueOf([ticketOf('demo-3467')], [canceledFact(fifteenDaysAgo)]);

  expect(due).toEqual({ date: '2026-10-20', archive: ['demo-3467'], statusFacts: [] });
});

it('keeps out a descendant unarchived after the root finished', () => {
  const tickets = [
    ticketOf('demo-3467'),
    ticketOf('demo-4789', { kind: 'slice', status: 'open', parent: idOf('demo-3467') }),
  ];

  const facts = [
    canceledFact(fifteenDaysAgo),
    factOf('demo-4789', '2026-10-10T12:00:00.000Z', { kind: 'unarchive' }),
  ];

  expect(archivedOf(tickets, facts)).toEqual(['demo-3467']);
});

it('archives a descendant again when its unarchive is older than the root finish', () => {
  const tickets = [
    ticketOf('demo-3467'),
    ticketOf('demo-4789', { kind: 'slice', status: 'open', parent: idOf('demo-3467') }),
  ];

  const facts = [
    factOf('demo-4789', '2026-09-01T12:00:00.000Z', { kind: 'unarchive' }),
    canceledFact(fifteenDaysAgo),
  ];

  expect(archivedOf(tickets, facts)).toEqual(['demo-3467', 'demo-4789']);
});

it('dates a finish from the newest status fact that matches the current status', () => {
  const facts = [
    canceledFact('2026-09-01T12:00:00.000Z'),
    factOf('demo-3467', '2026-09-02T12:00:00.000Z', { kind: 'status', status: 'open' }),
    canceledFact('2026-10-10T12:00:00.000Z'),
  ];

  expect(archivedOf([ticketOf('demo-3467')], facts)).toEqual([]);
});

it('asks for a status fact when the only status fact names another status', () => {
  const task = ticketOf('demo-3467', { kind: 'task', status: 'canceled' });
  const facts = [factOf('demo-3467', fifteenDaysAgo, { kind: 'status', status: 'done' })];

  expect(dueOf([task], facts)).toEqual({
    date: '2026-10-20',
    archive: [],
    statusFacts: [{ ticket: 'demo-3467', status: 'canceled' }],
  });
});

it('never archives an open plan or a stand-alone instruction that was not accepted', () => {
  const tickets = [
    ticketOf('demo-3467', { status: 'open' }),
    ticketOf('demo-4789', { kind: 'instruction', status: 'open' }),
  ];

  const facts = [
    factOf('demo-4789', fifteenDaysAgo, {
      kind: 'log',
      type: 'submitted',
      item: '5ab0000000a1',
      text: 'Done',
    }),
  ];

  expect(dueOf(tickets, facts)).toEqual({
    date: '2026-10-20',
    archive: [],
    statusFacts: [],
  });
});

it('never archives an instruction whose accept names an earlier submission', () => {
  const tickets = [ticketOf('demo-4789', { kind: 'instruction', status: 'open' })];

  const submittedOf = (item: string): Fact =>
    factOf('demo-4789', fifteenDaysAgo, { kind: 'log', type: 'submitted', item, text: 'Done' });

  const facts = [
    submittedOf('5ab0000000a1'),
    factOf('demo-4789', fifteenDaysAgo, { kind: 'reject', item: '5ab0000000a1', reason: 'No.' }),
    submittedOf('5ab0000000b1'),
    factOf('demo-4789', fifteenDaysAgo, { kind: 'accept', item: '5ab0000000a1' }),
  ];

  expect(dueOf(tickets, facts)).toEqual({ date: '2026-10-20', archive: [], statusFacts: [] });
});

it('visits each ticket once when hand edits make a parent cycle', () => {
  const tickets = [
    ticketOf('demo-3467', { parent: idOf('demo-4789') }),
    ticketOf('demo-4789', { kind: 'slice', status: 'open', parent: idOf('demo-3467') }),
  ];

  expect(archivedOf(tickets, [canceledFact(fifteenDaysAgo)])).toEqual(['demo-3467', 'demo-4789']);
});

it('leaves a canceled slice of an open plan to its plan', () => {
  const tickets = [
    ticketOf('demo-3467', { status: 'open' }),
    ticketOf('demo-4789', { kind: 'slice', status: 'canceled', parent: idOf('demo-3467') }),
  ];

  const facts = [factOf('demo-4789', fifteenDaysAgo, { kind: 'status', status: 'canceled' })];

  expect(dueOf(tickets, facts)).toEqual({ date: '2026-10-20', archive: [], statusFacts: [] });
});

it('treats an accept fact as a finish only for an open instruction', () => {
  const tickets = [
    ticketOf('demo-3467', { kind: 'instruction', status: 'draft' }),
    ticketOf('demo-4789', { kind: 'task', status: 'open' }),
  ];

  const facts = [
    factOf('demo-3467', fifteenDaysAgo, { kind: 'accept', item: '5ab0000000a1' }),
    factOf('demo-4789', fifteenDaysAgo, { kind: 'accept', item: '5ab0000000a1' }),
  ];

  expect(dueOf(tickets, facts)).toEqual({ date: '2026-10-20', archive: [], statusFacts: [] });
});

it('archives a descendant whose newer facts are not unarchive facts', () => {
  const tickets = [
    ticketOf('demo-3467'),
    ticketOf('demo-4789', { kind: 'slice', status: 'open', parent: idOf('demo-3467') }),
  ];

  const facts = [
    canceledFact(fifteenDaysAgo),
    factOf('demo-4789', '2026-10-10T12:00:00.000Z', { kind: 'status', status: 'open' }),
  ];

  expect(archivedOf(tickets, facts)).toEqual(['demo-3467', 'demo-4789']);
});

it('archives a ticket unarchived at the same moment the root finished', () => {
  const facts = [
    canceledFact(fifteenDaysAgo),
    factOf('demo-3467', fifteenDaysAgo, { kind: 'unarchive' }),
  ];

  expect(archivedOf([ticketOf('demo-3467')], facts)).toEqual(['demo-3467']);
});
