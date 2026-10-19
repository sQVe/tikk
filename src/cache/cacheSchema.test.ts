import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { openCache } from './cache.ts';
import {
  createDatabaseFixture,
  createFakeFiles,
  idsOf,
  ticketPath,
  ticketText,
  openTestCache,
  rewriteDatabaseText,
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

const listIds = async (): Promise<string[]> => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();

  fake.set(ticketPath('tikk-3a4b'), ticketText({ title: 'One' }));
  fake.set(ticketPath('tikk-3a4c'), ticketText({ title: 'Two' }));
  await cache.refresh(fake.files);

  return idsOf(cache.listTickets({ includeArchived: true }));
};

it('rebuilds a database with an unknown version and returns the same tickets', async () => {
  const before = await listIds();
  const database = new Database(databasePath);

  database.run("UPDATE meta SET value = 99 WHERE key = 'version'");
  database.close();

  expect(await listIds()).toEqual(before);
});

it('rebuilds a database without a version row', async () => {
  const before = await listIds();
  const database = new Database(databasePath);

  database.run('DROP TABLE meta');
  database.close();

  expect(await listIds()).toEqual(before);
});

it('rebuilds a file that is not a database', async () => {
  const before = await listIds();

  await writeFile(databasePath, 'these bytes are not a database, '.repeat(200));

  expect(await listIds()).toEqual(before);
});

it('returns the same tickets after the database file is deleted', async () => {
  const before = await listIds();

  await rm(databasePath);

  expect(await listIds()).toEqual(before);
  expect(before).toEqual(['tikk-3a4b', 'tikk-3a4c']);
});

it('returns a failure when the cache folder cannot be created', async () => {
  await writeFile(dirname(databasePath), 'a file where the folder belongs');

  const blockedPath = join(dirname(databasePath), 'nested', 'index.db');
  const opened = openCache(blockedPath);

  expect(opened.ok).toBe(false);

  if (!opened.ok) {
    expect(opened.reason.message).toContain(blockedPath);
  }
});

it('returns a failure instead of throwing when SQLite fails during refresh', async () => {
  using cache = openTestCache(databasePath);
  const database = new Database(databasePath);

  database.run('DROP TABLE tickets');
  database.close();

  const fake = createFakeFiles();

  fake.set(ticketPath('tikk-3a4b'), ticketText({ title: 'One' }));

  const refreshed = await cache.refresh(fake.files);

  expect(refreshed.ok).toBe(false);
});

const listWithoutRefresh = (): string[] => {
  using cache = openTestCache(databasePath);

  return idsOf(cache.listTickets({ includeArchived: true }));
};

it('keeps an intact database and its tickets across opens, and can still write', async () => {
  const before = await listIds();

  expect(listWithoutRefresh()).toEqual(before);

  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();

  fake.set(ticketPath('tikk-3a4d'), ticketText({ title: 'Three' }));

  const refreshed = await cache.refresh(fake.files);

  expect(refreshed.ok).toBe(true);
  expect(idsOf(cache.listTickets({ includeArchived: true }))).toEqual(['tikk-3a4d']);
});

const brokenSchemas: [string, string][] = [
  ['a missing ticket column', 'ALTER TABLE tickets DROP COLUMN error'],
  ['an extra ticket column', 'ALTER TABLE tickets ADD COLUMN extra TEXT'],
  ['an extra meta column', 'ALTER TABLE meta ADD COLUMN extra TEXT'],
  ['a missing version row', 'DELETE FROM meta'],
  ['an unknown version', "UPDATE meta SET value = 99 WHERE key = 'version'"],
  ['a version that is not a number', "UPDATE meta SET value = 'one' WHERE key = 'version'"],
];

const expectDiscardedAfter = async (sql: string): Promise<void> => {
  await listIds();
  runSql(databasePath, sql);

  expect(listWithoutRefresh()).toEqual([]);
  expect(await listIds()).toEqual(['tikk-3a4b', 'tikk-3a4c']);
};

for (const [name, sql] of brokenSchemas) {
  it(`discards a database with ${name}`, () => expectDiscardedAfter(sql));
}

it('discards a database that fails its integrity check', async () => {
  await listIds();
  rewriteDatabaseText(databasePath, 'hash TEXT NOT NULL', 'hash TEXT         ');
  runSql(databasePath, 'UPDATE tickets SET hash = NULL');
  rewriteDatabaseText(databasePath, 'hash TEXT         ', 'hash TEXT NOT NULL');

  expect(listWithoutRefresh()).toEqual([]);
});

it('returns a failure that names the path when the old cache cannot be removed', async () => {
  await mkdir(databasePath, { recursive: true });

  const opened = openCache(databasePath);

  expect(opened.ok).toBe(false);

  if (!opened.ok) {
    expect(opened.reason.message).toContain(databasePath);
  }
});

it.skipIf(process.getuid?.() === 0)(
  'returns a failure that names the path when the database cannot be created',
  async () => {
    await mkdir(dirname(databasePath), { recursive: true });
    await chmod(dirname(databasePath), 0o500);

    const opened = openCache(databasePath);

    await chmod(dirname(databasePath), 0o700);

    expect(opened.ok).toBe(false);

    if (!opened.ok) {
      expect(opened.reason.message).toContain(databasePath);
    }
  },
);

it.each(['-wal', '-shm', '-journal'])(
  'removes a leftover %s file when it rebuilds an unusable database',
  async (suffix) => {
    await listIds();
    await writeFile(databasePath, 'these bytes are not a database, '.repeat(200));
    await writeFile(`${databasePath}${suffix}`, 'leftover bytes');

    expect(listWithoutRefresh()).toEqual([]);
    expect(existsSync(`${databasePath}${suffix}`)).toBe(false);
  },
);

it('returns a failure that names the path when one leftover file cannot be removed', async () => {
  await listIds();
  await writeFile(databasePath, 'these bytes are not a database, '.repeat(200));
  await mkdir(join(`${databasePath}-shm`, 'inner'), { recursive: true });

  const opened = openCache(databasePath);

  expect(opened.ok).toBe(false);

  if (!opened.ok) {
    expect(opened.reason.message).toContain(`${databasePath}-shm`);
  }
});
