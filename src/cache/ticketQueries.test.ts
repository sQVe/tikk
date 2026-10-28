import { afterEach, beforeEach, expect, it } from 'bun:test';

import { parseTicketId } from '../ticket/ticket.ts';
import {
  createDatabaseFixture,
  createFakeFiles,
  idsOf,
  ticketPath,
  ticketText,
  okValueOf,
  openTestCache,
  runSql,
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
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();

  fake.set(ticketPath('tikk-3a4b'), ticketText({ title: 'Live' }));
  fake.set(ticketPath('tikk-3a4c'), ticketText({ title: 'Old', archived: '2026-01-02' }));
  await cache.refresh(fake.files);

  const visible = idsOf(okValueOf(cache.listTickets({ includeArchived: false })));
  const all = idsOf(okValueOf(cache.listTickets({ includeArchived: true })));

  expect(visible).toEqual(['tikk-3a4b']);
  expect(all).toEqual(['tikk-3a4b', 'tikk-3a4c']);
});

it('outlines archived tickets with their parent and leaves out a file with an error', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();

  fake.set(ticketPath('tikk-3a4b'), ticketText({ title: 'Live' }));

  fake.set(
    ticketPath('tikk-3a4c'),
    ticketText({ title: 'Old', archived: '2026-01-02', parent: 'tikk-3a4b' }),
  );

  fake.set(ticketPath('tikk-3a4d'), ticketText({ title: 'Broken later' }));
  await cache.refresh(fake.files);
  fake.set(ticketPath('tikk-3a4d'), '---\nkind: [\n---\n');
  await cache.refresh(fake.files);

  const outlines: unknown = okValueOf(cache.listTicketOutlines());

  expect(outlines).toEqual([
    { id: 'tikk-3a4b', frontMatter: { kind: 'instruction', title: 'Live', status: 'open' } },
    {
      id: 'tikk-3a4c',
      frontMatter: {
        kind: 'instruction',
        title: 'Old',
        status: 'open',
        parent: 'tikk-3a4b',
        archived: '2026-01-02',
      },
    },
  ]);
});

it('sorts tickets by project, then ID, and reports path, hash, and error', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();

  fake.set(ticketPath('zeta-3a4b', 'zeta'), ticketText({ title: 'Z' }).replace('tikk', 'zeta'));
  fake.set(ticketPath('tikk-3a4c'), ticketText({ title: 'B' }));
  fake.set(ticketPath('tikk-3a4b'), ticketText({ title: 'A' }));
  await cache.refresh(fake.files);

  const tickets = okValueOf(cache.listTickets({ includeArchived: false }));

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
  using cache = openTestCache(databasePath);
  const id = parseTicketId('tikk-3a4b');

  if (!id.ok) {
    throw new Error('bad id');
  }

  expect(cache.getTicket(id.value)).toMatchObject({ ok: false, reason: { kind: 'notFound' } });
});

it('finds the path of a ticket that has never parsed, and hides it from getTicket', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const id = parseTicketId('tikk-3a4b');

  if (!id.ok) {
    throw new Error('bad id');
  }

  fake.set(ticketPath('tikk-3a4b'), '---\nkind: [\n---\n');
  await cache.refresh(fake.files);

  expect(cache.findTicketPath(id.value)).toEqual({ ok: true, value: ticketPath('tikk-3a4b') });
  expect(cache.getTicket(id.value)).toMatchObject({ ok: false });
  expect(okValueOf(cache.listTickets({ includeArchived: true }))).toEqual([]);
});

it('returns a notFound result for the path of an unknown ID', () => {
  using cache = openTestCache(databasePath);
  const id = parseTicketId('tikk-3a4b');

  if (!id.ok) {
    throw new Error('bad id');
  }

  expect(cache.findTicketPath(id.value)).toMatchObject({ ok: false, reason: { kind: 'notFound' } });
});

it('returns parent, rank, and blockedBy of a ticket', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();

  fake.set(
    ticketPath('tikk-3a4b'),
    ticketText({ title: 'Linked', parent: 'tikk-3a4c', rank: 2.5, blockedBy: ['tikk-3a4d'] }),
  );

  await cache.refresh(fake.files);

  const id = parseTicketId('tikk-3a4b');

  if (!id.ok) {
    throw new Error('bad id');
  }

  const found = cache.getTicket(id.value);

  expect(found.ok && found.value.frontMatter).toMatchObject({
    parent: 'tikk-3a4c',
    rank: 2.5,
    blockedBy: ['tikk-3a4d'],
  });
});

const taskText = (title: string, extra: string): string =>
  `---\nkind: task\ntitle: ${title}\nproject: tikk\nstatus: open\n${extra}---\n`;

it('returns new for a loose open task and leaves it out of a task with no flag', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();

  fake.set(ticketPath('tikk-3a4b'), taskText('Marked', 'new: true\n'));
  fake.set(ticketPath('tikk-3a4c'), taskText('Plain', ''));

  await cache.refresh(fake.files);

  const markedId = parseTicketId('tikk-3a4b');
  const plainId = parseTicketId('tikk-3a4c');

  if (!markedId.ok || !plainId.ok) {
    throw new Error('bad id');
  }

  const marked = cache.getTicket(markedId.value);
  const plain = cache.getTicket(plainId.value);

  expect(marked.ok && marked.value.frontMatter.new).toBe(true);
  expect(plain.ok && plain.value.frontMatter.new).toBeUndefined();
});

it('returns the criteria and covers of a slice', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();

  const sliceText = [
    '---',
    'kind: slice',
    'title: Slice',
    'project: tikk',
    'status: open',
    'criteria:',
    '  - id: refuse-parent',
    '    check: Test in ticketNew.test.ts',
    '    expected: The plan is refused.',
    'covers: [plan-criterion]',
    '---',
    'Body.\n',
  ].join('\n');

  fake.set(ticketPath('tikk-3a4b'), sliceText);
  await cache.refresh(fake.files);

  const id = parseTicketId('tikk-3a4b');

  if (!id.ok) {
    throw new Error('bad id');
  }

  const found = cache.getTicket(id.value);

  expect(found.ok && found.value.frontMatter).toMatchObject({
    criteria: [
      { id: 'refuse-parent', check: 'Test in ticketNew.test.ts', expected: 'The plan is refused.' },
    ],
    covers: ['plan-criterion'],
  });
});

it('throws instead of returning a ticket row it cannot read', async () => {
  {
    using cache = openTestCache(databasePath);
    const fake = createFakeFiles();

    fake.set(ticketPath('tikk-3a4b'), ticketText({ title: 'One' }));
    await cache.refresh(fake.files);
  }

  runSql(databasePath, "UPDATE tickets SET status = 'bogus'");

  using cache = openTestCache(databasePath);
  const id = parseTicketId('tikk-3a4b');

  if (!id.ok) {
    throw new Error('bad id');
  }

  expect(() => cache.getTicket(id.value)).toThrow();
  expect(() => cache.listTickets({ includeArchived: true })).toThrow();
});

it('throws instead of returning an error row it cannot read', async () => {
  {
    using cache = openTestCache(databasePath);
    const fake = createFakeFiles();

    fake.set('/fake/tickets/tikk/notes.md', ticketText({ title: 'One' }));
    await cache.refresh(fake.files);
  }

  runSql(databasePath, "UPDATE tickets SET error = x'00'");

  using cache = openTestCache(databasePath);

  expect(() => cache.listErrors()).toThrow();
});
