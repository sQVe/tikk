import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Result } from '../result.ts';

export interface CacheOpenReason {
  message: string;
}

const cacheVersion = 1;

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
  database.run('CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)');
  database.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['version', cacheVersion]);
};

const hasCurrentVersion = (database: Database): boolean => {
  try {
    const row = database.query("SELECT value FROM meta WHERE key = 'version'").get();
    const value = row !== null && typeof row === 'object' && 'value' in row ? row.value : undefined;

    return value === cacheVersion;
  } catch {
    return false;
  }
};

const removeDatabaseFiles = (path: string): void => {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(`${path}${suffix}`, { force: true });
  }
};

const openExisting = (path: string): Database | undefined => {
  let database: Database | undefined;

  try {
    database = new Database(path, { readwrite: true });
  } catch {
    return undefined;
  }

  if (hasCurrentVersion(database)) {
    return database;
  }

  database.close();

  return undefined;
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const createDatabase = (path: string): Result<Database, CacheOpenReason> => {
  try {
    const database = new Database(path, { create: true, readwrite: true });

    createTables(database);

    return { ok: true, value: database };
  } catch (error) {
    return { ok: false, reason: { message: describeError(error) } };
  }
};

const prepareDatabaseFolder = (path: string): CacheOpenReason | undefined => {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (error) {
    return { message: `Cannot create the cache folder for ${path}: ${describeError(error)}` };
  }

  return undefined;
};

const clearDatabaseFiles = (path: string): CacheOpenReason | undefined => {
  try {
    removeDatabaseFiles(path);
  } catch (error) {
    return { message: `Cannot remove the old cache at ${path}: ${describeError(error)}` };
  }

  return undefined;
};

export const openDatabase = (path: string): Result<Database, CacheOpenReason> => {
  const folderProblem = prepareDatabaseFolder(path);

  if (folderProblem !== undefined) {
    return { ok: false, reason: folderProblem };
  }

  const existing = openExisting(path);

  if (existing !== undefined) {
    return { ok: true, value: existing };
  }

  const clearProblem = clearDatabaseFiles(path);

  if (clearProblem !== undefined) {
    return { ok: false, reason: clearProblem };
  }

  const created = createDatabase(path);

  if (!created.ok) {
    return {
      ok: false,
      reason: {
        message: `The cache database at ${path} cannot be created: ${created.reason.message}`,
      },
    };
  }

  return created;
};
