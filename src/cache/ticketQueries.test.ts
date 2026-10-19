import { afterEach, beforeEach, expect, it } from 'bun:test';

import { parseTicketId } from '../ticket/ticket.ts';
import { openCache } from './cache.ts';
import {
  createDatabaseFixture,
  createFakeFiles,
  idsOf,
  ticketPath,
  ticketText,
} from './cacheHarness.ts';

let databasePath = '';
let cleanup = async () => {};

beforeEach(async () => {
  ({ databasePath, cleanup } = await createDatabaseFixture());
});

afterEach(async () => {
  await cleanup();
});

it('leaves out an archived ticket unless includeArchived is true', async () => {
  using cache = openCache(databasePath);
  const fake = createFakeFiles();

  fake.set(ticketPath('tikk-3a4b'), ticketText({ title: 'Live' }));
  fake.set(ticketPath('tikk-3a4c'), ticketText({ title: 'Old', archived: '2026-01-02' }));
  await cache.refresh(fake.files);

  const visible = idsOf(cache.listTickets({ includeArchived: false }));
  const all = idsOf(cache.listTickets({ includeArchived: true }));

  expect(visible).toEqual(['tikk-3a4b']);
  expect(all).toEqual(['tikk-3a4b', 'tikk-3a4c']);
});

it('sorts tickets by project, then ID, and reports path, hash, and error', async () => {
  using cache = openCache(databasePath);
  const fake = createFakeFiles();

  fake.set(ticketPath('zeta-3a4b', 'zeta'), ticketText({ title: 'Z' }).replace('tikk', 'zeta'));
  fake.set(ticketPath('tikk-3a4c'), ticketText({ title: 'B' }));
  fake.set(ticketPath('tikk-3a4b'), ticketText({ title: 'A' }));
  await cache.refresh(fake.files);

  const tickets = cache.listTickets({ includeArchived: false });

  expect(idsOf(tickets)).toEqual(['tikk-3a4b', 'tikk-3a4c', 'zeta-3a4b']);

  expect(tickets[0]).toMatchObject({
    path: ticketPath('tikk-3a4b'),
    error: null,
    frontMatter: { title: 'A', blockedBy: [] },
    body: 'Body.\n',
  });

  expect(tickets[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
});

it('returns a notFound result for an unknown ID', () => {
  using cache = openCache(databasePath);
  const id = parseTicketId('tikk-3a4b');

  if (!id.ok) {
    throw new Error('bad id');
  }

  expect(cache.getTicket(id.value)).toMatchObject({ ok: false, reason: { kind: 'notFound' } });
});
