import { afterEach, beforeEach, expect, it } from 'bun:test';

import type { Fact } from '../fact/fact.ts';
import { parseTicketId } from '../ticket/ticket.ts';
import {
  createDatabaseFixture,
  createFakeFiles,
  factPath,
  factText,
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

  expect(ticketsOf(cache.listFacts())).toEqual(['me-3a4b', 'me-3a4c']);

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

  expect(ticketsOf(cache.listFacts())).toEqual(['me-3a4c']);
});

it('skips an incomplete last line until it ends in a newline', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = factPath();
  const whole = factText('me-3a4c');
  const cut = whole.slice(0, 20);

  fake.setFactFile(path, factText('me-3a4b') + cut);
  await cache.refresh(fake.files);

  expect(ticketsOf(cache.listFacts())).toEqual(['me-3a4b']);
  expect(cache.listErrors()).toEqual([]);

  fake.setFactFile(path, factText('me-3a4b') + whole);
  await cache.refresh(fake.files);

  expect(ticketsOf(cache.listFacts())).toEqual(['me-3a4b', 'me-3a4c']);
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
  expect(ticketsOf(cache.listFacts())).toEqual(['me-3a4b', 'me-3a4c']);
});

it('rereads a fact file that shrank', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = factPath();

  fake.setFactFile(path, factText('me-3a4b') + factText('me-3a4c'));
  await cache.refresh(fake.files);

  fake.setFactFile(path, factText('me-3a4d'));
  await cache.refresh(fake.files);

  expect(ticketsOf(cache.listFacts())).toEqual(['me-3a4d']);
});

it('orders facts by time, then file path, then line', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();
  const first = '2026-10-20T09:00:00Z';
  const second = '2026-10-20T09:00:00.5Z';

  fake.setFactFile(factPath('b'), factText('me-3a4b', { kind: 'accept' }, first));
  fake.setFactFile(factPath('a'), factText('me-3a4c', { kind: 'accept' }, first));
  fake.setFactFile(factPath('c'), factText('me-3a4d', { kind: 'accept' }, second));
  await cache.refresh(fake.files);

  expect(ticketsOf(cache.listFacts())).toEqual(['me-3a4c', 'me-3a4b', 'me-3a4d']);
});

it('lists only the facts of the given tickets', async () => {
  using cache = openTestCache(databasePath);
  const fake = createFakeFiles();

  fake.setFactFile(factPath(), factText('me-3a4b') + factText('me-3a4c'));
  await cache.refresh(fake.files);

  expect(ticketsOf(cache.listFacts([idOf('me-3a4c')]))).toEqual(['me-3a4c']);
  expect(cache.listFacts([])).toEqual([]);
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

  expect(cache.listFacts()).toEqual([]);

  await cache.refresh(fake.files);

  expect(ticketsOf(cache.listFacts())).toEqual(['me-3a4b']);
});
