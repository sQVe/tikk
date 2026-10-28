import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { stat } from 'node:fs/promises';

import { deriveInstructionState } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import { invariant } from '../invariant.ts';
import { parseProjectName, parseTicketId } from '../ticket/ticket.ts';
import type { CacheFiles, TicketCache } from './cache.ts';
import {
  createDatabaseFixture,
  createFakeFiles,
  factPath,
  factsOf,
  factText,
  idsOf,
  makeGate,
  okValueOf,
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
  expect(idsOf(okValueOf(cache.listTickets({ includeArchived: true })))).toEqual(['tikk-3a4b']);
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
  expect(okValueOf(cache.listErrors())).toHaveLength(1);
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
  expect(okValueOf(cache.listErrors())).toHaveLength(1);
});

it('fails the refresh when the rebuilt rows are still unreadable', async () => {
  {
    using cache = openTestCache(databasePath);

    expect(okValueOf(cache.listTickets({ includeArchived: true }))).toEqual([]);
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

it('indexes the facts again from the files when the cache holds a fact file cursor that is not a number', async () => {
  const fake = createFakeFiles();

  fake.setFactFile(factPath(), factText('tikk-3a4b'));

  {
    using cache = openTestCache(databasePath);

    await cache.refresh(fake.files);
  }

  runSql(databasePath, "UPDATE fact_files SET bytes_read = 'abc'");

  using cache = openTestCache(databasePath);
  const refreshed = await cache.refresh(fake.files);

  expect(refreshed.ok).toBe(true);
  expect(idsOf(factsOf(cache).map(({ ticket }) => ({ id: ticket })))).toEqual(['tikk-3a4b']);
});

const factTampers: [string, string][] = [
  ['text that is not JSON', "UPDATE facts SET json = 'not json'"],
  ['JSON that is not a fact', "UPDATE facts SET json = '{}'"],
  ['a claim without a holder', "UPDATE facts SET json = json_remove(json, '$.holder')"],
  ['a stored value that is not text', "UPDATE facts SET json = x'00'"],
];

const claimText = factText('tikk-3a4b', {
  kind: 'claim',
  holder: 'agent',
  leaseEnd: '2026-10-20T13:00:00.000Z',
});

const expectDamageThenFactsFromFiles = async (sql: string): Promise<void> => {
  const fake = createFakeFiles();

  fake.setFactFile(factPath(), claimText);

  {
    using cache = openTestCache(databasePath);

    await cache.refresh(fake.files);
  }

  runSql(databasePath, sql);

  using cache = openTestCache(databasePath);

  expect(cache.listFacts()).toMatchObject({ ok: false, reason: { kind: 'damaged' } });

  const refreshed = await cache.rebuildFacts(fake.files);

  expect(refreshed.ok).toBe(true);
  expect(factsOf(cache)).toMatchObject([{ kind: 'claim', holder: 'agent' }]);
};

for (const [name, sql] of factTampers) {
  it(`reports damage for a stored fact with ${name}, and reads the facts again after a reset`, () =>
    expectDamageThenFactsFromFiles(sql));
}

it('lists only the facts that decide an instruction state', async () => {
  const fake = createFakeFiles();
  const note = { kind: 'log', type: 'progress', text: 'A note' };
  const submitted = { kind: 'log', type: 'submitted', item: '5ab0000000a1', text: '' };
  const reject = { kind: 'reject', item: '5ab0000000a1', reason: 'Tests fail.' };

  fake.setFactFile(
    factPath(),
    factText('tikk-3a4b', note, '2026-10-20T10:00:00.000Z') +
      factText('tikk-3a4b', submitted, '2026-10-20T10:01:00.000Z') +
      factText('tikk-3a4b', reject, '2026-10-20T10:02:00.000Z') +
      factText('tikk-3a4b', { kind: 'accept', item: '5ab0000000a1' }, '2026-10-20T10:03:00.000Z'),
  );

  using cache = openTestCache(databasePath);

  await cache.refresh(fake.files);

  const stateFacts = cache.listStateFacts();

  expect(stateFacts.ok && stateFacts.value.map((fact) => fact.kind)).toEqual([
    'log',
    'reject',
    'accept',
  ]);

  expect(factsOf(cache)).toHaveLength(4);
});

it('lists status and unarchive facts as state facts', async () => {
  const fake = createFakeFiles();
  const note = { kind: 'log', type: 'progress', text: 'A note' };

  fake.setFactFile(
    factPath(),
    factText('tikk-3a4b', note, '2026-10-20T10:00:00.000Z') +
      factText('tikk-3a4b', { kind: 'status', status: 'done' }, '2026-10-20T10:01:00.000Z') +
      factText('tikk-3a4b', { kind: 'unarchive' }, '2026-10-20T10:02:00.000Z'),
  );

  using cache = openTestCache(databasePath);

  await cache.refresh(fake.files);

  const stateFacts = cache.listStateFacts();

  expect(stateFacts.ok && stateFacts.value.map((fact) => fact.kind)).toEqual([
    'status',
    'unarchive',
  ]);
});

it('lists only the facts that date a finish or an unarchive, and submissions, as archive facts', async () => {
  const fake = createFakeFiles();
  const claim = { kind: 'claim', holder: 'agent', leaseEnd: '2099-01-01T00:00:00.000Z' };
  const progress = { kind: 'log', type: 'progress', text: 'Halfway' };
  const submitted = { kind: 'log', type: 'submitted', text: '', item: '5ab0000000a1' };

  fake.setFactFile(
    factPath(),
    factText('tikk-3a4b', claim, '2026-10-20T10:00:00.000Z') +
      factText('tikk-3a4b', progress, '2026-10-20T10:00:20.000Z') +
      factText('tikk-3a4b', submitted, '2026-10-20T10:00:40.000Z') +
      factText('tikk-3a4b', { kind: 'accept', item: '5ab0000000a1' }, '2026-10-20T10:01:00.000Z') +
      factText('tikk-3a4b', { kind: 'status', status: 'done' }, '2026-10-20T10:02:00.000Z') +
      factText('tikk-3a4c', { kind: 'unarchive' }, '2026-10-20T10:03:00.000Z'),
  );

  using cache = openTestCache(databasePath);

  await cache.refresh(fake.files);

  const archiveFacts = cache.listArchiveFacts();

  expect(
    archiveFacts.ok && archiveFacts.value.map((fact) => `${fact.ticket} ${fact.kind}`),
  ).toEqual(['tikk-3a4b log', 'tikk-3a4b accept', 'tikk-3a4b status', 'tikk-3a4c unarchive']);
});

it('lists a release with the claim it ends, so the instruction is open again', async () => {
  const fake = createFakeFiles();
  const claim = { kind: 'claim', holder: 'agent', leaseEnd: '2099-01-01T00:00:00.000Z' };

  fake.setFactFile(
    factPath(),
    factText('me-3a4b', claim, '2026-10-20T10:00:00.000Z') +
      factText('me-3a4b', { kind: 'release', holder: 'agent' }, '2026-10-20T10:01:00.000Z'),
  );

  using cache = openTestCache(databasePath);

  await cache.refresh(fake.files);

  const listed = cache.listStateFacts();

  invariant(listed.ok, 'The state facts must decode.');

  const id = parseTicketId('me-3a4b');
  const project = parseProjectName('me');

  invariant(id.ok && project.ok, 'The test names must be valid.');

  const ticket = {
    id: id.value,
    frontMatter: {
      kind: 'instruction' as const,
      title: 'T',
      project: project.value,
      blockedBy: [],
      discoveredFrom: [],
      related: [],
      status: 'open' as const,
    },
  };

  expect(
    deriveInstructionState(ticket, listed.value, new Date('2026-10-20T12:00:00.000Z')).state,
  ).toBe('open');
});

it('keeps an active claim visible to another handle while the facts are rebuilt', async () => {
  const fake = createFakeFiles();
  const claim = { kind: 'claim', holder: 'agent', leaseEnd: '2099-01-01T00:00:00.000Z' };

  fake.setFactFile(factPath(), factText('me-3a4b', claim));

  using rebuilder = openTestCache(databasePath);
  using reader = openTestCache(databasePath);

  await rebuilder.refresh(fake.files);

  const gate = makeGate();
  const readFactFile = fake.files.readFactFile;

  const rebuild = rebuilder.rebuildFacts({
    ...fake.files,
    readFactFile: async (factFile, fromByte) => {
      await gate.wait();

      return readFactFile(factFile, fromByte);
    },
  });

  await gate.reached;

  const during = reader.listStateFacts();

  gate.open();

  expect((await rebuild).ok).toBe(true);

  const after = reader.listStateFacts();

  expect(during.ok && during.value.map((fact) => fact.kind)).toEqual(['claim']);
  expect(after.ok && after.value.map((fact) => fact.kind)).toEqual(['claim']);
});

const liveClaim = { kind: 'claim', holder: 'agent', leaseEnd: '2099-01-01T00:00:00.000Z' };

const stateFactTickets = (cache: TicketCache): string[] => {
  const listed = cache.listStateFacts();

  invariant(listed.ok, 'The state facts must decode.');

  return listed.value.map((fact) => fact.ticket);
};

const afterFirstRead = (files: CacheFiles, between: () => Promise<void>): CacheFiles => {
  let first = true;

  return {
    ...files,
    readFactFile: async (factFile, fromByte) => {
      const read = await files.readFactFile(factFile, fromByte);

      if (first) {
        first = false;
        await between();
      }

      return read;
    },
  };
};

it('keeps a claim that another handle indexed between the rebuild read and its publish', async () => {
  const fake = createFakeFiles();
  const first = factText('me-3a4b', liveClaim, '2026-10-20T10:00:00.000Z');

  fake.setFactFile(factPath(), first);

  using rebuilder = openTestCache(databasePath);
  using claimant = openTestCache(databasePath);

  await rebuilder.refresh(fake.files);

  const rebuilt = await rebuilder.rebuildFacts(
    afterFirstRead(fake.files, async () => {
      fake.setFactFile(
        factPath(),
        first + factText('me-3a4c', liveClaim, '2026-10-20T10:01:00.000Z'),
      );

      await claimant.refresh(fake.files);
    }),
  );

  expect(rebuilt.ok).toBe(true);
  expect(stateFactTickets(claimant)).toEqual(['me-3a4b', 'me-3a4c']);
  expect(stateFactTickets(rebuilder)).toEqual(['me-3a4b', 'me-3a4c']);
});

it('fails the rebuild when another process keeps indexing the fact files', async () => {
  const fake = createFakeFiles();

  fake.setFactFile(factPath(), factText('me-3a4b', liveClaim));

  using cache = openTestCache(databasePath);

  await cache.refresh(fake.files);

  const rebuilt = await cache.rebuildFacts({
    ...fake.files,
    readFactFile: async (factFile, fromByte) => {
      const read = await fake.files.readFactFile(factFile, fromByte);

      runSql(databasePath, 'UPDATE fact_files SET lines_read = lines_read + 1');

      return read;
    },
  });

  expect(rebuilt).toMatchObject({ ok: false, reason: { kind: 'failed' } });
  expect(stateFactTickets(cache)).toEqual(['me-3a4b']);
});

it('keeps the old facts and fails when a fact file cannot be read during a rebuild', async () => {
  const fake = createFakeFiles();

  fake.setFactFile(factPath(), factText('me-3a4b', liveClaim));

  using cache = openTestCache(databasePath);

  await cache.refresh(fake.files);

  const rebuilt = await cache.rebuildFacts({
    ...fake.files,
    readFactFile: () =>
      Promise.resolve({ ok: false, reason: { kind: 'failed', message: 'Cannot read.' } }),
  });

  expect(rebuilt).toMatchObject({ ok: false, reason: { message: 'Cannot read.' } });
  expect(stateFactTickets(cache)).toEqual(['me-3a4b']);
});

it('skips a fact file that vanishes during a rebuild', async () => {
  const fake = createFakeFiles();

  fake.setFactFile(factPath(), factText('me-3a4b', liveClaim));
  fake.setFactFile(factPath('desktop'), factText('me-3a4c', liveClaim));

  using cache = openTestCache(databasePath);

  const rebuilt = await cache.rebuildFacts({
    ...fake.files,
    readFactFile: (factFile, fromByte) => {
      if (factFile === factPath('desktop')) {
        return Promise.resolve({ ok: false, reason: { kind: 'notFound', message: 'Gone.' } });
      }

      return fake.files.readFactFile(factFile, fromByte);
    },
  });

  expect(rebuilt.ok).toBe(true);
  expect(stateFactTickets(cache)).toEqual(['me-3a4b']);
});

it('reports a SQLite failure of a rebuild as a failed result, and throws any other error', async () => {
  const fake = createFakeFiles();

  fake.setFactFile(factPath(), factText('me-3a4b', liveClaim));

  using cache = openTestCache(databasePath);

  runSql(databasePath, 'DROP TABLE facts');

  const sqlite = await cache.rebuildFacts(fake.files);

  expect(sqlite).toMatchObject({ ok: false, reason: { kind: 'failed' } });

  const other = cache.rebuildFacts({
    ...fake.files,
    readFactFile: () => Promise.reject(new Error('Not SQLite.')),
  });

  const thrown = await other.then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(thrown).toBeInstanceOf(Error);
  expect(String(thrown)).toContain('other than SQLite');
});

it('keeps the claims visible to another handle while a damaged cursor is repaired', async () => {
  const fake = createFakeFiles();

  fake.setFactFile(factPath(), factText('me-3a4b', liveClaim));

  using repairer = openTestCache(databasePath);
  using reader = openTestCache(databasePath);

  await repairer.refresh(fake.files);
  runSql(databasePath, "UPDATE fact_files SET bytes_read = 'abc'");

  let seen: string[] = [];

  const refreshed = await repairer.refresh(
    afterFirstRead(fake.files, () => {
      seen = stateFactTickets(reader);

      return Promise.resolve();
    }),
  );

  expect(refreshed.ok).toBe(true);
  expect(seen).toEqual(['me-3a4b']);
  expect(stateFactTickets(reader)).toEqual(['me-3a4b']);
});

const tikkId = () => {
  const id = parseTicketId('tikk-3a4b');

  invariant(id.ok, 'The test ID must be valid.');

  return id.value;
};

it('refreshes the tickets after it repairs a damaged fact cursor', async () => {
  const fake = createFakeFiles();

  fake.set(path, ticketText({ title: 'One' }));
  fake.setFactFile(factPath(), factText('tikk-3a4b', liveClaim));

  using cache = openTestCache(databasePath);

  await cache.refresh(fake.files);
  runSql(databasePath, "UPDATE fact_files SET bytes_read = 'abc'");
  fake.set(path, ticketText({ title: 'Renamed', archived: '2026-10-01' }));

  const refreshed = await cache.refresh(fake.files);
  const ticket = cache.getTicket(tikkId());

  expect(refreshed.ok).toBe(true);
  expect(ticket.ok && ticket.value.frontMatter.title).toBe('Renamed');
});

it('returns the failure and keeps the facts when an automatic rebuild cannot read a file', async () => {
  const fake = createFakeFiles();

  fake.setFactFile(factPath(), factText('tikk-3a4b', liveClaim));

  using cache = openTestCache(databasePath);

  await cache.refresh(fake.files);
  runSql(databasePath, "UPDATE fact_files SET bytes_read = 'abc'");

  const refreshed = await cache.refresh({
    ...fake.files,
    readFactFile: () =>
      Promise.resolve({ ok: false, reason: { kind: 'failed', message: 'Cannot read.' } }),
  });

  expect(refreshed).toMatchObject({ ok: false, reason: { message: 'Cannot read.' } });
  expect(stateFactTickets(cache)).toEqual(['tikk-3a4b']);
});

it('does not report success when another handle damages a ticket row during the file listing', async () => {
  const fake = await seedOneTicket();

  using cache = openTestCache(databasePath);

  const refreshed = await cache.refresh({
    ...fake.files,
    listTicketFiles: async () => {
      runSql(databasePath, "UPDATE tickets SET blocked_by = 'not json'");

      return fake.files.listTicketFiles();
    },
  });

  expect(refreshed.ok).toBe(false);
});

it('does not report success when another handle damages a ticket row during an automatic fact rebuild', async () => {
  const fake = await seedOneTicket();

  fake.setFactFile(factPath(), factText('me-3a4b', liveClaim));

  using cache = openTestCache(databasePath);

  await cache.refresh(fake.files);

  runSql(databasePath, "UPDATE fact_files SET bytes_read = 'abc'");

  const refreshed = await cache.refresh({
    ...fake.files,
    readFactFile: async (factFile, fromByte) => {
      const read = await fake.files.readFactFile(factFile, fromByte);

      runSql(databasePath, "UPDATE tickets SET blocked_by = 'not json'");

      return read;
    },
  });

  expect(refreshed.ok).toBe(false);
});

const lockDatabase = (databaseFile: string): Database => {
  const holder = new Database(databaseFile);

  holder.run('BEGIN EXCLUSIVE');

  return holder;
};

it('returns a failed result for a query that stays busy and keeps the database file', async () => {
  await seedOneTicket();

  using cache = openTestCache(databasePath, 10);

  const inode = (await stat(databasePath)).ino;
  const holder = lockDatabase(databasePath);
  const busy = cache.getTicket(tikkId());

  holder.run('ROLLBACK');
  holder.close();

  expect(busy.ok).toBe(false);

  if (!busy.ok) {
    expect(busy.reason.kind).toBe('failed');
  }

  expect((await stat(databasePath)).ino).toBe(inode);
  expect(cache.getTicket(tikkId()).ok).toBe(true);
});

it('reports a fact query that stays busy as failed, not as damaged', async () => {
  await seedOneTicket();

  using cache = openTestCache(databasePath, 10);

  const holder = lockDatabase(databasePath);
  const busy = cache.listStateFacts();

  holder.run('ROLLBACK');
  holder.close();

  expect(busy.ok).toBe(false);

  if (!busy.ok) {
    expect(busy.reason.kind).toBe('failed');
  }
});

const oldAndNewIds = () => {
  const oldId = parseTicketId('tikk-3a4b');
  const newId = parseTicketId('tikk-9fk4');

  invariant(oldId.ok && newId.ok, 'The test IDs should parse.');

  return { oldId: oldId.value, newId: newId.value };
};

const nonAliasKinds = (facts: Fact[]): string[] =>
  facts.flatMap((fact) => (fact.kind === 'alias' ? [] : [fact.kind]));

it('moves the facts an alias names to its new ticket in every fact query', async () => {
  const { oldId, newId } = oldAndNewIds();
  const fake = createFakeFiles();

  const movedLines =
    factText('tikk-3a4b', {
      kind: 'claim',
      holder: 'agent',
      leaseEnd: '2026-10-20T13:00:00.000Z',
    }) +
    factText(
      'tikk-3a4b',
      { kind: 'log', type: 'progress', text: 'A note' },
      '2026-10-20T10:01:00.000Z',
    ) +
    factText('tikk-3a4b', { kind: 'accept', item: '5ab0000000a1' }, '2026-10-20T10:02:00.000Z');

  const unnamedLine = factText(
    'tikk-3a4b',
    { kind: 'log', type: 'progress', text: 'Later note' },
    '2026-10-20T10:03:00.000Z',
  );

  const alias = factText(
    'tikk-9fk4',
    {
      kind: 'alias',
      from: 'tikk-3a4b',
      movedFacts: [1, 2, 3].map((line) => ({ path: 'laptop/2026-10.jsonl', line })),
    },
    '2026-10-20T10:05:00.000Z',
  );

  fake.set(ticketPath('tikk-9fk4'), ticketText({ title: 'Renamed' }));
  fake.setFactFile(factPath(), movedLines + unnamedLine);
  fake.setFactFile(factPath('desk'), alias);

  using cache = openTestCache(databasePath);

  await cache.refresh(fake.files);

  const expectMovedFacts = (): void => {
    expect(nonAliasKinds(factsOf(cache, [oldId]))).toEqual(['log']);
    expect(nonAliasKinds(factsOf(cache, [newId]))).toEqual(['claim', 'log', 'accept']);

    const state = cache.listStateFacts([newId]);

    expect(state.ok && nonAliasKinds(state.value)).toEqual(['claim', 'accept']);
    expect(cache.listStateFacts([oldId])).toEqual({ ok: true, value: [] });

    const archived = cache.listArchiveFacts();

    expect(archived.ok && archived.value.map((fact) => [fact.kind, fact.ticket])).toEqual([
      ['accept', newId],
    ]);
  };

  expectMovedFacts();

  await cache.rebuildFacts(fake.files);

  expectMovedFacts();
});

it('an alias with no moved facts leaves the facts on its old ticket', async () => {
  const { oldId, newId } = oldAndNewIds();
  const fake = createFakeFiles();

  fake.setFactFile(
    factPath(),
    factText('tikk-3a4b', { kind: 'log', type: 'progress', text: 'A note' }),
  );

  fake.setFactFile(factPath('desk'), factText('tikk-9fk4', { kind: 'alias', from: 'tikk-3a4b' }));

  using cache = openTestCache(databasePath);

  await cache.refresh(fake.files);

  expect(nonAliasKinds(factsOf(cache, [oldId]))).toEqual(['log']);
  expect(nonAliasKinds(factsOf(cache, [newId]))).toEqual([]);
});

const idOf = (value: string) => {
  const parsed = parseTicketId(value);

  invariant(parsed.ok, 'The test ID should parse.');

  return parsed.value;
};

const logTextsOf = (facts: Fact[]): string[] =>
  facts.flatMap((fact) => (fact.kind === 'log' ? [fact.text] : []));

it('moves a reference through a second alias that moves the first alias line', async () => {
  const fake = createFakeFiles();

  const claimAndLog =
    factText('tikk-3a4b', {
      kind: 'claim',
      holder: 'agent',
      leaseEnd: '2026-10-20T13:00:00.000Z',
    }) +
    factText(
      'tikk-3a4b',
      { kind: 'log', type: 'progress', text: 'B progress' },
      '2026-10-20T10:01:00.000Z',
    );

  fake.set(ticketPath('tikk-9fk4'), ticketText({ title: 'Renamed once' }));
  fake.set(ticketPath('tikk-7wx4'), ticketText({ title: 'Renamed twice' }));
  fake.setFactFile(factPath(), claimAndLog);

  fake.setFactFile(
    factPath('desk'),
    factText(
      'tikk-9fk4',
      {
        kind: 'alias',
        from: 'tikk-3a4b',
        movedFacts: [1, 2].map((line) => ({ path: 'laptop/2026-10.jsonl', line })),
      },
      '2026-10-20T10:05:00.000Z',
    ),
  );

  fake.setFactFile(
    factPath('third'),
    factText(
      'tikk-7wx4',
      { kind: 'alias', from: 'tikk-9fk4', movedFacts: [{ path: 'desk/2026-10.jsonl', line: 1 }] },
      '2026-10-20T10:06:00.000Z',
    ),
  );

  fake.setFactFile(
    factPath('clone'),
    factText(
      'tikk-9fk4',
      { kind: 'log', type: 'progress', text: 'C progress' },
      '2026-10-20T10:07:00.000Z',
    ),
  );

  using cache = openTestCache(databasePath);

  await cache.refresh(fake.files);

  const expectOwners = (): void => {
    expect(nonAliasKinds(factsOf(cache, [idOf('tikk-7wx4')]))).toEqual(['claim', 'log']);
    expect(logTextsOf(factsOf(cache, [idOf('tikk-7wx4')]))).toEqual(['B progress']);
    expect(logTextsOf(factsOf(cache, [idOf('tikk-9fk4')]))).toEqual(['C progress']);
    expect(factsOf(cache, [idOf('tikk-3a4b')])).toEqual([]);
  };

  expectOwners();

  await cache.rebuildFacts(fake.files);

  expectOwners();
});

it('applies an alias move only once the ticket file under its new ID exists', async () => {
  const { oldId, newId } = oldAndNewIds();
  const fake = createFakeFiles();

  fake.setFactFile(
    factPath(),
    factText('tikk-3a4b', { kind: 'log', type: 'progress', text: 'B progress' }),
  );

  fake.setFactFile(
    factPath('desk'),
    factText(
      'tikk-9fk4',
      { kind: 'alias', from: 'tikk-3a4b', movedFacts: [{ path: 'laptop/2026-10.jsonl', line: 1 }] },
      '2026-10-20T10:05:00.000Z',
    ),
  );

  using cache = openTestCache(databasePath);

  await cache.refresh(fake.files);

  expect(logTextsOf(factsOf(cache, [oldId]))).toEqual(['B progress']);
  expect(logTextsOf(factsOf(cache, [newId]))).toEqual([]);

  fake.set(ticketPath('tikk-9fk4'), ticketText({ title: 'Renamed' }));

  await cache.refresh(fake.files);

  expect(logTextsOf(factsOf(cache, [newId]))).toEqual(['B progress']);
  expect(logTextsOf(factsOf(cache, [oldId]))).toEqual([]);
});
