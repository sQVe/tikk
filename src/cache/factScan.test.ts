import { afterEach, beforeEach, expect, it } from 'bun:test';

import type { Fact } from '../fact/fact.ts';
import { parseTicketId } from '../ticket/ticket.ts';
import {
  createDatabaseFixture,
  createFakeFiles,
  factPath,
  factsOf,
  factText,
  makeGate,
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

const idOf = (value: string) => {
  const parsed = parseTicketId(value);

  if (!parsed.ok) {
    throw new Error(parsed.reason.message);
  }

  return parsed.value;
};

const ticketsOf = (facts: Fact[]): string[] => facts.map((fact) => String(fact.ticket));

const claim = { kind: 'claim', holder: 'agent', leaseEnd: '2026-10-21T10:00:00.000Z' };

it('indexes an appended line on the next refresh and keeps the earlier facts', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = factPath();

  fake.setFactFile(path, factText('me-3a4b', claim));
  await cache.refresh(fake.files);

  const first = factText('me-3a4c');

  fake.setFactFile(path, factText('me-3a4b', claim) + first);
  await cache.refresh(fake.files);

  expect(ticketsOf(factsOf(cache))).toEqual(['me-3a4b', 'me-3a4c']);

  expect(fake.factReads().map((read) => read.fromByte)).toEqual([
    0,
    factText('me-3a4b', claim).length,
  ]);
});

it('removes the facts of a deleted fact file', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();

  fake.setFactFile(factPath('laptop'), factText('me-3a4b'));
  fake.setFactFile(factPath('desktop'), factText('me-3a4c'));
  await cache.refresh(fake.files);

  fake.removeFactFile(factPath('laptop'));
  await cache.refresh(fake.files);

  expect(ticketsOf(factsOf(cache))).toEqual(['me-3a4c']);
});

it('skips an incomplete last line until it ends in a newline', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = factPath();
  const whole = factText('me-3a4c');
  const cut = whole.slice(0, 20);

  fake.setFactFile(path, factText('me-3a4b') + cut);
  await cache.refresh(fake.files);

  expect(ticketsOf(factsOf(cache))).toEqual(['me-3a4b']);
  expect(cache.listErrors()).toEqual([]);

  fake.setFactFile(path, factText('me-3a4b') + whole);
  await cache.refresh(fake.files);

  expect(ticketsOf(factsOf(cache))).toEqual(['me-3a4b', 'me-3a4c']);
  expect(cache.listErrors()).toEqual([]);
});

it('reports a bad line as path:line:message and indexes the other lines', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = factPath();

  fake.setFactFile(path, `${factText('me-3a4b')}not json\n${factText('me-3a4c')}`);
  await cache.refresh(fake.files);

  const errors = cache.listErrors();

  expect(errors).toHaveLength(1);
  expect(errors[0]?.path).toBe(`${path}:2`);
  expect(errors[0]?.message).toContain('not valid JSON');
  expect(ticketsOf(factsOf(cache))).toEqual(['me-3a4b', 'me-3a4c']);
});

it('rereads a fact file that shrank', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = factPath();

  fake.setFactFile(path, factText('me-3a4b') + factText('me-3a4c'));
  await cache.refresh(fake.files);

  fake.setFactFile(path, factText('me-3a4d'));
  await cache.refresh(fake.files);

  expect(ticketsOf(factsOf(cache))).toEqual(['me-3a4d']);
});

it('orders facts by time, then file path, then line', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const first = '2026-10-20T09:00:00Z';
  const second = '2026-10-20T09:00:00.5Z';

  fake.setFactFile(
    factPath('b'),
    factText('me-3a4b', { kind: 'accept', item: '5ab0000000a1' }, first),
  );

  fake.setFactFile(
    factPath('a'),
    factText('me-3a4c', { kind: 'accept', item: '5ab0000000a1' }, first),
  );

  fake.setFactFile(
    factPath('c'),
    factText('me-3a4d', { kind: 'accept', item: '5ab0000000a1' }, second),
  );

  await cache.refresh(fake.files);

  expect(ticketsOf(factsOf(cache))).toEqual(['me-3a4c', 'me-3a4b', 'me-3a4d']);
});

it('lists only the facts of the given tickets', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();

  fake.setFactFile(factPath(), factText('me-3a4b') + factText('me-3a4c'));
  await cache.refresh(fake.files);

  expect(ticketsOf(factsOf(cache, [idOf('me-3a4c')]))).toEqual(['me-3a4c']);
  expect(factsOf(cache, [])).toEqual([]);
});

it('rebuilds a cache with an old version and indexes the facts again', async () => {
  const fake = createFakeFiles();

  fake.setFactFile(factPath(), factText('me-3a4b'));

  {
    using cache = openTestCache(databasePath);

    await cache.refresh(fake.files);
  }

  runSql(databasePath, "UPDATE meta SET value = 1 WHERE key = 'version'");

  using cache = openTestCache(databasePath);

  expect(factsOf(cache)).toEqual([]);

  await cache.refresh(fake.files);

  expect(ticketsOf(factsOf(cache))).toEqual(['me-3a4b']);
});

it('keeps facts that a newer refresh indexed when an older refresh saw no fact file', async () => {
  using older = openTestCache(databasePath);
  using newer = openTestCache(databasePath);
  const fake = createFakeFiles();
  const gate = makeGate();

  const pausedFiles = {
    ...fake.files,
    listFactFiles: async () => {
      await gate.wait();

      return { ok: true as const, value: [] };
    },
  };

  const olderRefresh = older.refresh(pausedFiles);

  await gate.reached;
  fake.setFactFile(factPath(), factText('me-3a4b', claim));
  await newer.refresh(fake.files);
  gate.open();
  await olderRefresh;

  expect(ticketsOf(factsOf(newer))).toEqual(['me-3a4b']);
});

it('skips the lines an older refresh read when a newer refresh indexed the file first', async () => {
  using older = openTestCache(databasePath);
  using newer = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = factPath();
  const gate = makeGate();

  fake.setFactFile(path, factText('me-3a4b', claim));

  const pausedFiles = {
    ...fake.files,
    readFactFile: async (filePath: string, fromByte: number) => {
      const read = await fake.files.readFactFile(filePath, fromByte);

      await gate.wait();

      return read;
    },
  };

  const olderRefresh = older.refresh(pausedFiles);

  await gate.reached;
  fake.setFactFile(path, factText('me-3a4b', claim) + factText('me-3a4c'));
  await newer.refresh(fake.files);
  gate.open();
  await olderRefresh;

  const readsBefore = fake.factReads().length;

  await newer.refresh(fake.files);

  expect(ticketsOf(factsOf(newer))).toEqual(['me-3a4b', 'me-3a4c']);
  expect(fake.factReads().length).toBe(readsBefore);
});

it('fails the refresh and keeps the cached facts when a fact file read fails', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = factPath();

  fake.setFactFile(path, factText('me-3a4b'));
  await cache.refresh(fake.files);
  fake.setFactFile(path, factText('me-3a4b') + factText('me-3a4c'));

  const refreshed = await cache.refresh({
    ...fake.files,
    readFactFile: () =>
      Promise.resolve({ ok: false, reason: { kind: 'failed', message: 'Cannot read.' } }),
  });

  expect(refreshed.ok).toBe(false);
  expect(ticketsOf(factsOf(cache))).toEqual(['me-3a4b']);
});

it('fails the refresh when the fact file row keeps changing under every read', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = factPath();

  fake.setFactFile(path, factText('me-3a4b'));
  await cache.refresh(fake.files);
  fake.setFactFile(path, factText('me-3a4b') + factText('me-3a4c'));

  const refreshed = await cache.refresh({
    ...fake.files,
    readFactFile: async (filePath: string, fromByte: number) => {
      runSql(databasePath, 'UPDATE fact_files SET mtime_ms = mtime_ms + 1000');

      return fake.files.readFactFile(filePath, fromByte);
    },
  });

  expect(refreshed).toMatchObject({ ok: false, reason: { kind: 'failed' } });
});

it('reads again and removes a deleted file whose row another refresh changed meanwhile', async () => {
  using older = openTestCache(databasePath);
  using newer = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = factPath();
  const gate = makeGate();

  fake.setFactFile(path, factText('me-3a4b'));
  await older.refresh(fake.files);

  const olderRefresh = older.refresh({
    ...fake.files,
    listFactFiles: async () => {
      await gate.wait();

      return fake.files.listFactFiles();
    },
  });

  await gate.reached;
  fake.setFactFile(path, factText('me-3a4b') + factText('me-3a4c'));
  await newer.refresh(fake.files);
  fake.removeFactFile(path);
  gate.open();

  const refreshed = await olderRefresh;

  expect(refreshed.ok).toBe(true);
  expect(factsOf(older)).toEqual([]);
});
