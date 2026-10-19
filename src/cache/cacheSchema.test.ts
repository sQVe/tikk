import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { openCache } from './cache.ts';
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

  const opened = openCache(join(dirname(databasePath), 'nested', 'index.db'));

  expect(opened.ok).toBe(false);
  expect(!opened.ok && opened.reason.message).not.toBe('');
});
