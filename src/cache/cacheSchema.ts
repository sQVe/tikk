import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

import { invariant } from '../invariant.ts';

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

const createDatabase = (
  path: string,
): { ok: true; database: Database } | { ok: false; message: string } => {
  try {
    const database = new Database(path, { create: true, readwrite: true });

    createTables(database);

    return { ok: true, database };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
};

export const openDatabase = (path: string): Database => {
  mkdirSync(dirname(path), { recursive: true });

  const existing = openExisting(path);

  if (existing !== undefined) {
    return existing;
  }

  removeDatabaseFiles(path);

  const created = createDatabase(path);

  const detail = created.ok ? '' : created.message;

  invariant(created.ok, `The cache database at ${path} cannot be created: ${detail}`);

  return created.database;
};
