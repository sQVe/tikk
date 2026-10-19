import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, it } from 'bun:test';

import {
  createDatabaseFixture,
  createFakeFiles,
  idsOf,
  openTestCache,
  runSql,
  ticketPath,
  ticketText,
} from './cacheHarness.ts';
import type { FakeFiles } from './cacheHarness.ts';

let databasePath = '';
let cleanup = async () => {};

beforeEach(async () => {
  ({ databasePath, cleanup } = await createDatabaseFixture());
});

afterEach(async () => {
  await cleanup();
});

const path = ticketPath('tikk-3a4b');

const seedOneTicket = async (): Promise<FakeFiles> => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();

  fake.set(path, ticketText({ title: 'One' }));
  await cache.refresh(fake.files);

  return fake;
};

const tampers: [string, string][] = [
  ['a stored mtime that is not a number', "UPDATE tickets SET mtime_ms = 'abc'"],
  ['a rank that is not a number', "UPDATE tickets SET rank = 'abc'"],
  ['an ID that is not valid', "UPDATE tickets SET id = 'bad id'"],
  ['a status that is not valid', "UPDATE tickets SET status = 'bogus'"],
  ['a blocked_by value that is not JSON', "UPDATE tickets SET blocked_by = 'not json'"],
  ['a title that is not text', "UPDATE tickets SET title = x'00'"],
];

const expectRebuiltAfter = async (sql: string): Promise<void> => {
  const fake = await seedOneTicket();

  runSql(databasePath, sql);

  using cache = openTestCache(databasePath);
  const refreshed = await cache.refresh(fake.files);

  expect(refreshed.ok).toBe(true);
  expect(idsOf(cache.listTickets({ includeArchived: true }))).toEqual(['tikk-3a4b']);
  expect(fake.reads()).toBe(2);
};

for (const [name, sql] of tampers) {
  it(`rebuilds from the files when the cache holds ${name}`, () => expectRebuiltAfter(sql));
}

it('keeps a valid error-only row without reading its file again', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();

  fake.set('/fake/tickets/tikk/notes.md', ticketText({ title: 'One' }));
  await cache.refresh(fake.files);
  await cache.refresh(fake.files);

  expect(fake.reads()).toBe(1);
  expect(cache.listErrors()).toHaveLength(1);
});

it('rebuilds from the files when an error-only row has no error', async () => {
  const fake = createFakeFiles();

  fake.set('/fake/tickets/tikk/notes.md', ticketText({ title: 'One' }));

  {
    using cache = openTestCache(databasePath);

    await cache.refresh(fake.files);
  }

  runSql(databasePath, 'UPDATE tickets SET error = NULL');

  using cache = openTestCache(databasePath);

  await cache.refresh(fake.files);

  expect(fake.reads()).toBe(2);
  expect(cache.listErrors()).toHaveLength(1);
});

it('fails the refresh when the rebuilt rows are still unreadable', async () => {
  {
    using cache = openTestCache(databasePath);

    expect(cache.listTickets({ includeArchived: true })).toEqual([]);
  }

  runSql(
    databasePath,
    "CREATE TRIGGER corrupt AFTER INSERT ON tickets BEGIN UPDATE tickets SET status = 'bogus' WHERE path = NEW.path; END",
  );

  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();

  fake.set(path, ticketText({ title: 'One' }));

  const refreshed = await cache.refresh(fake.files);

  expect(refreshed.ok).toBe(false);

  if (!refreshed.ok) {
    expect(refreshed.reason.kind).toBe('failed');
    expect(refreshed.reason.message).not.toBe('');
  }
});

it('reports a SQLite failure as a failed refresh with a message', async () => {
  using cache = openTestCache(databasePath);
  const database = new Database(databasePath);

  database.run('DROP TABLE tickets');
  database.close();

  const refreshed = await cache.refresh(createFakeFiles().files);

  expect(refreshed.ok).toBe(false);

  if (!refreshed.ok) {
    expect(refreshed.reason.kind).toBe('failed');
    expect(refreshed.reason.message).toContain('tickets');
  }
});

const nonSqliteErrors: [string, unknown][] = [
  ['an error without a code', new Error('plain')],
  ['an error with another code', Object.assign(new Error('other'), { code: 'ENOENT' })],
  ['a value that is not an error', { code: 'SQLITE_BUSY' }],
];

const outcomeOfRefreshThrowing = async (thrown: unknown): Promise<string> => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();

  const refreshing = cache.refresh({
    ...fake.files,
    listTicketFiles: () => {
      throw thrown;
    },
  });

  return await refreshing.then(
    () => 'resolved',
    () => 'rejected',
  );
};

for (const [name, thrown] of nonSqliteErrors) {
  it(`does not swallow ${name} thrown during a refresh`, async () => {
    expect(await outcomeOfRefreshThrowing(thrown)).toBe('rejected');
  });
}

it('closes the database when the cache is disposed', () => {
  const cache = openTestCache(databasePath);
  cache[Symbol.dispose]();

  expect(() => cache.listTickets({ includeArchived: true })).toThrow();
});
