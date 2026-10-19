import { afterEach, beforeEach, expect, it } from 'bun:test';

import { parseTicketId } from '../ticket/ticket.ts';
import type { TicketCache } from './cache.ts';
import {
  createDatabaseFixture,
  createFakeFiles,
  idsOf,
  ticketPath,
  ticketText,
  openTestCache,
} from './cacheHarness.ts';

let databasePath = '';
let cleanup = async () => {};

beforeEach(async () => {
  ({ databasePath, cleanup } = await createDatabaseFixture());
});

afterEach(async () => {
  await cleanup();
});

const idOf = (value: string) => {
  const parsed = parseTicketId(value);

  if (!parsed.ok) {
    throw new Error(parsed.reason.message);
  }

  return parsed.value;
};

const titleOf = (cache: TicketCache, id: string): string | undefined => {
  const found = cache.getTicket(idOf(id));

  return found.ok ? found.value.frontMatter.title : undefined;
};

it('keeps the last good title for a broken file and clears the error when it is restored', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = ticketPath('tikk-3a4b');
  const good = ticketText({ title: 'Good title' });

  fake.set(path, good);
  expect((await cache.refresh(fake.files)).ok).toBe(true);

  fake.set(path, '---\ntitle: [\n---\n');
  expect((await cache.refresh(fake.files)).ok).toBe(true);

  expect(titleOf(cache, 'tikk-3a4b')).toBe('Good title');
  expect(cache.listErrors().map((error) => error.path)).toEqual([path]);

  fake.set(path, good);
  await cache.refresh(fake.files);

  expect(cache.listErrors()).toEqual([]);
  expect(titleOf(cache, 'tikk-3a4b')).toBe('Good title');
});

it('shows a changed title after refresh', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = ticketPath('tikk-3a4b');

  fake.set(path, ticketText({ title: 'Old' }));
  await cache.refresh(fake.files);
  fake.set(path, ticketText({ title: 'New' }));
  await cache.refresh(fake.files);

  expect(titleOf(cache, 'tikk-3a4b')).toBe('New');
});

it('removes a deleted file from the list', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();

  fake.set(ticketPath('tikk-3a4b'), ticketText({ title: 'One' }));
  fake.set(ticketPath('tikk-3a4c'), ticketText({ title: 'Two' }));
  await cache.refresh(fake.files);
  fake.remove(ticketPath('tikk-3a4b'));
  await cache.refresh(fake.files);

  const ids = idsOf(cache.listTickets({ includeArchived: false }));

  expect(ids).toEqual(['tikk-3a4c']);
});

it('drops a file that vanishes between list and read', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = ticketPath('tikk-3a4b');

  fake.set(path, ticketText({ title: 'One' }));
  await cache.refresh(fake.files);

  fake.set(path, ticketText({ title: 'Two' }));

  const vanishing = {
    ...fake.files,
    readTicketFile: async (target: string) => {
      fake.remove(target);

      return fake.files.readTicketFile(target);
    },
  };

  const result = await cache.refresh(vanishing);

  expect(result.ok).toBe(true);
  expect(cache.listTickets({ includeArchived: false })).toEqual([]);
});

it('does not read a file whose mtime and size are unchanged', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();

  fake.set(ticketPath('tikk-3a4b'), ticketText({ title: 'One' }));
  await cache.refresh(fake.files);
  const readsAfterFirst = fake.reads();
  await cache.refresh(fake.files);

  expect(readsAfterFirst).toBe(1);
  expect(fake.reads()).toBe(readsAfterFirst);
});

it('keeps the parsed state when only the mtime changes', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = ticketPath('tikk-3a4b');

  fake.set(path, ticketText({ title: 'One' }));
  await cache.refresh(fake.files);
  fake.set(path, ticketText({ title: 'One' }));
  await cache.refresh(fake.files);

  expect(fake.reads()).toBe(2);
  expect(titleOf(cache, 'tikk-3a4b')).toBe('One');
  expect(cache.listErrors()).toEqual([]);
});

it('records an error-only row for a file name without an ID', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = '/fake/tickets/tikk/notes.md';

  fake.set(path, ticketText({ title: 'One' }));
  await cache.refresh(fake.files);

  expect(cache.listTickets({ includeArchived: true })).toEqual([]);
  expect(cache.listErrors().map((error) => error.path)).toEqual([path]);
});

it('gives the later path an error that names the duplicate', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const first = ticketPath('tikk-3a4b');
  const second = '/fake/tickets/tikk/tikk-3a4b-zzz.md';

  fake.set(first, ticketText({ title: 'First' }));
  fake.set(second, ticketText({ title: 'Second' }));
  await cache.refresh(fake.files);

  expect(titleOf(cache, 'tikk-3a4b')).toBe('First');
  const errors = cache.listErrors();

  expect(errors.map((error) => error.path)).toEqual([second]);
  expect(errors[0]?.message).toContain(first);

  fake.remove(first);
  await cache.refresh(fake.files);

  expect(titleOf(cache, 'tikk-3a4b')).toBe('Second');
  expect(cache.listErrors()).toEqual([]);
});

it('fails the refresh when the file list fails', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();

  fake.set(ticketPath('tikk-3a4b'), ticketText({ title: 'One' }));
  await cache.refresh(fake.files);

  const result = await cache.refresh({
    ...fake.files,
    listTicketFiles: async () => ({ ok: false, reason: { kind: 'failed', message: 'denied' } }),
  });

  expect(result).toMatchObject({ ok: false, reason: { kind: 'failed' } });
  expect(titleOf(cache, 'tikk-3a4b')).toBe('One');
});

it('reads a file again when its size changes but its mtime does not', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = ticketPath('tikk-3a4b');

  fake.set(path, ticketText({ title: 'One' }), 5);
  await cache.refresh(fake.files);
  fake.set(path, ticketText({ title: 'Longer title' }), 5);
  await cache.refresh(fake.files);

  expect(titleOf(cache, 'tikk-3a4b')).toBe('Longer title');
});

it('does not read a file again after only its mtime changed once', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = ticketPath('tikk-3a4b');

  fake.set(path, ticketText({ title: 'One' }));
  await cache.refresh(fake.files);
  fake.set(path, ticketText({ title: 'One' }));
  await cache.refresh(fake.files);
  await cache.refresh(fake.files);

  expect(fake.reads()).toBe(2);
});

it('reads files in path order', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const first = ticketPath('tikk-3a4b');
  const second = ticketPath('tikk-3a4c');
  const third = ticketPath('tikk-3a4d');

  fake.set(third, ticketText({ title: 'Three' }));
  fake.set(first, ticketText({ title: 'One' }));
  fake.set(second, ticketText({ title: 'Two' }));
  await cache.refresh(fake.files);

  expect(fake.readPaths()).toEqual([first, second, third]);
});

it('records an error for a file that cannot be read and reads it again next time', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = ticketPath('tikk-3a4b');
  let reads = 0;

  fake.set(path, ticketText({ title: 'One' }));

  const failing = {
    ...fake.files,
    readTicketFile: (target: string) => {
      reads += 1;

      return Promise.resolve({
        ok: false as const,
        reason: { kind: 'failed' as const, message: `Cannot read ${target}.` },
      });
    },
  };

  const refreshed = await cache.refresh(failing);

  expect(refreshed.ok).toBe(true);
  const errors = cache.listErrors();

  expect(errors.map((error) => error.path)).toEqual([path]);
  expect(errors[0]?.message).toContain(path);

  await cache.refresh(failing);

  expect(reads).toBe(2);

  await cache.refresh(fake.files);

  expect(cache.listErrors()).toEqual([]);
  expect(titleOf(cache, 'tikk-3a4b')).toBe('One');
});

it('records an error that names a project folder that is not a valid name', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = '/fake/tickets/Bad Name/tikk-3a4b-slug.md';

  fake.set(path, ticketText({ title: 'One' }));

  const refreshed = await cache.refresh(fake.files);
  const errors = cache.listErrors();

  expect(refreshed.ok).toBe(true);
  expect(errors.map((error) => error.path)).toEqual([path]);
  expect(errors[0]?.message).toContain('Bad Name');
  expect(cache.listTickets({ includeArchived: true })).toEqual([]);
});

it('gives no addressable ticket for a file in an invalid project folder', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = '/fake/tickets/Bad Name/undefined-3467-slug.md';

  fake.set(path, ticketText({ title: 'One' }));
  await cache.refresh(fake.files);

  expect(cache.findTicketPath(idOf('undefined-3467'))).toMatchObject({
    ok: false,
    reason: { kind: 'notFound' },
  });

  expect(cache.getTicket(idOf('undefined-3467')).ok).toBe(false);
});
