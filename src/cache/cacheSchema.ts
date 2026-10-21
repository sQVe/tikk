import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

import { z } from 'zod';

import type { Result } from '../result.ts';

export interface CacheOpenReason {
  kind: 'busy' | 'failed';
  message: string;
}

type VersionCheck = 'current' | 'outdated' | 'busy';

const cacheVersion = 3;

// Other tikk processes write the same cache, so a query waits for their lock instead of failing.
const defaultBusyTimeoutMilliseconds = 5000;

const isBusyError = (error: unknown): boolean => {
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';

  return code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED');
};

const waitForLocks = (database: Database, busyTimeoutMilliseconds: number): Database => {
  database.run(`PRAGMA busy_timeout = ${busyTimeoutMilliseconds}`);

  return database;
};

const createTables = (database: Database): void => {
  database.run(
    `CREATE TABLE tickets (
      path TEXT PRIMARY KEY,
      mtime_ms REAL NOT NULL,
      size INTEGER NOT NULL,
      hash TEXT NOT NULL,
      id TEXT,
      kind TEXT,
      title TEXT,
      project TEXT,
      parent TEXT,
      rank REAL,
      blocked_by TEXT,
      status TEXT,
      archived TEXT,
      body TEXT,
      error TEXT
    )`,
  );

  database.run('CREATE INDEX tickets_id ON tickets (id)');

  database.run(
    `CREATE TABLE facts (
      path TEXT NOT NULL,
      line INTEGER NOT NULL,
      ticket TEXT NOT NULL,
      kind TEXT NOT NULL,
      at TEXT NOT NULL,
      log_type TEXT,
      json TEXT NOT NULL,
      PRIMARY KEY (path, line)
    )`,
  );

  database.run('CREATE INDEX facts_ticket ON facts (ticket)');

  database.run(
    `CREATE TABLE fact_errors (
      path TEXT NOT NULL,
      line INTEGER NOT NULL,
      message TEXT NOT NULL,
      PRIMARY KEY (path, line)
    )`,
  );

  database.run(
    `CREATE TABLE fact_files (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      bytes_read INTEGER NOT NULL,
      lines_read INTEGER NOT NULL
    )`,
  );

  database.run('CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)');
  database.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['version', cacheVersion]);
};

const intactRowSchema = z.object({ quick_check: z.literal('ok') });

const versionRowSchema = z.object({ value: z.number() });

const isIntact = (database: Database): boolean =>
  intactRowSchema.safeParse(database.query('PRAGMA quick_check').get()).success;

const requiredColumns = new Map([
  [
    'tickets',
    'path,mtime_ms,size,hash,id,kind,title,project,parent,rank,blocked_by,status,archived,body,error',
  ],
  ['facts', 'path,line,ticket,kind,at,log_type,json'],
  ['fact_errors', 'path,line,message'],
  ['fact_files', 'path,size,mtime_ms,bytes_read,lines_read'],
  ['meta', 'key,value'],
]);

const hasExpectedTables = (database: Database): boolean => {
  for (const [table, columns] of requiredColumns) {
    const rows = database.query('SELECT name FROM pragma_table_info(?)').values(table);
    const names = rows.map((row) => String(row[0]));

    if (names.toSorted().join(',') !== columns.split(',').toSorted().join(',')) {
      return false;
    }
  }

  return true;
};

const checkVersion = (database: Database): VersionCheck => {
  try {
    if (!hasExpectedTables(database)) {
      return 'outdated';
    }

    const row = versionRowSchema.safeParse(
      database.query("SELECT value FROM meta WHERE key = 'version'").get(),
    );

    const current = row.success && row.data.value === cacheVersion && isIntact(database);

    return current ? 'current' : 'outdated';
  } catch (error) {
    // A database that another process holds is not damaged, so it must not be rebuilt.
    return isBusyError(error) ? 'busy' : 'outdated';
  }
};

const removeDatabaseFiles = (path: string): void => {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(`${path}${suffix}`, { force: true });
  }
};

const openExisting = (
  path: string,
  busyTimeoutMilliseconds: number,
): Result<Database | undefined, CacheOpenReason> => {
  let database: Database | undefined;

  try {
    database = waitForLocks(new Database(path, { readwrite: true }), busyTimeoutMilliseconds);
  } catch {
    return { ok: true, value: undefined };
  }

  const version = checkVersion(database);

  if (version === 'current') {
    return { ok: true, value: database };
  }

  database.close();

  if (version === 'busy') {
    const message = `The cache at ${path} is busy in another process. Try again.`;

    return { ok: false, reason: { kind: 'busy', message } };
  }

  return { ok: true, value: undefined };
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const createDatabase = (
  path: string,
  busyTimeoutMilliseconds: number,
): Result<Database, CacheOpenReason> => {
  try {
    const database = waitForLocks(new Database(path, { create: true }), busyTimeoutMilliseconds);

    createTables(database);

    return { ok: true, value: database };
  } catch (error) {
    return { ok: false, reason: { kind: 'failed', message: describeError(error) } };
  }
};

const prepareDatabaseFolder = (path: string): CacheOpenReason | undefined => {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (error) {
    return {
      kind: 'failed',
      message: `Cannot create the cache folder for ${path}: ${describeError(error)}`,
    };
  }

  return undefined;
};

const clearDatabaseFiles = (path: string): CacheOpenReason | undefined => {
  try {
    removeDatabaseFiles(path);
  } catch (error) {
    return {
      kind: 'failed',
      message: `Cannot remove the old cache at ${path}: ${describeError(error)}`,
    };
  }

  return undefined;
};

export const openDatabase = (
  path: string,
  busyTimeoutMilliseconds = defaultBusyTimeoutMilliseconds,
): Result<Database, CacheOpenReason> => {
  const folderProblem = prepareDatabaseFolder(path);

  if (folderProblem !== undefined) {
    return { ok: false, reason: folderProblem };
  }

  const existing = openExisting(path, busyTimeoutMilliseconds);

  if (!existing.ok) {
    return existing;
  }

  if (existing.value !== undefined) {
    return { ok: true, value: existing.value };
  }

  const clearProblem = clearDatabaseFiles(path);

  if (clearProblem !== undefined) {
    return { ok: false, reason: clearProblem };
  }

  const created = createDatabase(path, busyTimeoutMilliseconds);

  if (!created.ok) {
    return {
      ok: false,
      reason: {
        kind: 'failed',
        message: `The cache database at ${path} cannot be created: ${created.reason.message}`,
      },
    };
  }

  return created;
};
