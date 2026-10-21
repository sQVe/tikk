import type { Database } from 'bun:sqlite';

import { z } from 'zod';

import { parseFactLine } from '../fact/fact.ts';
import type { Result } from '../result.ts';

interface FactFileEntry {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface FactFileReason {
  kind: 'notFound' | 'changedOnDisk' | 'failed';
  message: string;
}

export interface FactCacheFiles {
  listFactFiles: () => Promise<Result<FactFileEntry[], FactFileReason>>;
  readFactFile: (path: string, fromByte: number) => Promise<Result<Uint8Array, FactFileReason>>;
}

type Pass = 'applied' | 'conflict';

const storedFileSchema = z.object({
  path: z.string(),
  size: z.number(),
  mtime_ms: z.number(),
  bytes_read: z.number(),
  lines_read: z.number(),
});

type StoredFile = z.infer<typeof storedFileSchema>;

const newline = 0x0a;

const loadStoredFile = (database: Database, path: string): StoredFile | undefined => {
  const row = database
    .query('SELECT path, size, mtime_ms, bytes_read, lines_read FROM fact_files WHERE path = ?')
    .get(path);

  return row === null ? undefined : storedFileSchema.parse(row);
};

const isSameStoredFile = (left: StoredFile | undefined, right: StoredFile | undefined): boolean =>
  left?.size === right?.size &&
  left?.mtime_ms === right?.mtime_ms &&
  left?.bytes_read === right?.bytes_read;

const maximumPasses = 5;

// Another process may refresh the same cache at the same time. A change applies only when the row
// still matches the one this refresh started from, so an older refresh never undoes a newer one.
// Returns `false` when the row moved, so the caller reads that file again.
const writeIfUnchanged = (
  database: Database,
  path: string,
  basis: StoredFile | undefined,
  write: () => void,
): boolean =>
  database
    .transaction(() => {
      if (!isSameStoredFile(loadStoredFile(database, path), basis)) {
        return false;
      }

      write();

      return true;
    })
    .immediate();

export const hasValidFactCursors = (database: Database): boolean =>
  z
    .array(storedFileSchema)
    .safeParse(
      database.query('SELECT path, size, mtime_ms, bytes_read, lines_read FROM fact_files').all(),
    ).success;

const clearFacts = (database: Database): void => {
  database.run('DELETE FROM facts');
  database.run('DELETE FROM fact_errors');
  database.run('DELETE FROM fact_files');
};

const loadStoredFiles = (database: Database): Map<string, StoredFile> => {
  const rows = z
    .array(storedFileSchema)
    .parse(
      database.query('SELECT path, size, mtime_ms, bytes_read, lines_read FROM fact_files').all(),
    );

  return new Map(rows.map((row) => [row.path, row]));
};

const deleteFile = (database: Database, path: string): void => {
  database.run('DELETE FROM facts WHERE path = ?', [path]);
  database.run('DELETE FROM fact_errors WHERE path = ?', [path]);
  database.run('DELETE FROM fact_files WHERE path = ?', [path]);
};

const isUnchanged = (stored: StoredFile | undefined, entry: FactFileEntry): boolean =>
  stored?.size === entry.size && stored.mtime_ms === entry.mtimeMs;

const hasShrunk = (stored: StoredFile | undefined, entry: FactFileEntry): boolean =>
  stored !== undefined && entry.size < stored.bytes_read;

const recordLines = (database: Database, path: string, firstLine: number, text: string): number => {
  const lines = text.split('\n');

  // The text ends in a newline, so the last piece is empty.
  lines.pop();

  for (const [index, lineText] of lines.entries()) {
    const line = firstLine + index;
    const parsed = parseFactLine(lineText);

    if (parsed.ok) {
      const fact = parsed.value;

      database.run(
        `INSERT OR REPLACE INTO facts (path, line, ticket, kind, at, log_type, json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          path,
          line,
          fact.ticket,
          fact.kind,
          fact.at,
          fact.kind === 'log' ? fact.type : null,
          lineText,
        ],
      );
    } else {
      database.run('INSERT OR REPLACE INTO fact_errors (path, line, message) VALUES (?, ?, ?)', [
        path,
        line,
        parsed.reason.message,
      ]);
    }
  }

  return lines.length;
};

const applyBytes = (
  database: Database,
  entry: FactFileEntry,
  stored: StoredFile | undefined,
  bytes: Uint8Array,
): void => {
  const completeLength = bytes.lastIndexOf(newline) + 1;
  const text = new TextDecoder().decode(bytes.subarray(0, completeLength));
  const linesRead = stored?.lines_read ?? 0;
  const added = recordLines(database, entry.path, linesRead + 1, text);

  database.run(
    `INSERT INTO fact_files (path, size, mtime_ms, bytes_read, lines_read) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (path) DO UPDATE SET
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      bytes_read = excluded.bytes_read,
      lines_read = excluded.lines_read`,
    [
      entry.path,
      entry.size,
      entry.mtimeMs,
      (stored?.bytes_read ?? 0) + completeLength,
      linesRead + added,
    ],
  );
};

const refreshFactFile = async (
  database: Database,
  files: FactCacheFiles,
  entry: FactFileEntry,
  previous: StoredFile | undefined,
): Promise<Result<Pass, FactFileReason>> => {
  if (isUnchanged(previous, entry)) {
    return { ok: true, value: 'applied' };
  }

  const reread = hasShrunk(previous, entry);
  const base = reread ? undefined : previous;
  const read = await files.readFactFile(entry.path, base?.bytes_read ?? 0);

  if (!read.ok && read.reason.kind !== 'notFound') {
    return read;
  }

  const written = writeIfUnchanged(database, entry.path, previous, () => {
    if (reread || !read.ok) {
      deleteFile(database, entry.path);
    }

    if (read.ok) {
      applyBytes(database, entry, base, read.value);
    }
  });

  return { ok: true, value: written ? 'applied' : 'conflict' };
};

const refreshFactsOnce = async (
  database: Database,
  files: FactCacheFiles,
): Promise<Result<Pass, FactFileReason>> => {
  let pass: Pass = 'applied';

  // The rows load before the listing, so a file indexed by another process after this point is not
  // in the basis, and this refresh does not delete it.
  const stored = loadStoredFiles(database);
  const listed = await files.listFactFiles();

  if (!listed.ok) {
    return listed;
  }

  const present = new Set(listed.value.map((entry) => entry.path));

  for (const [path, basis] of stored) {
    if (!present.has(path)) {
      const written = writeIfUnchanged(database, path, basis, () => {
        deleteFile(database, path);
      });

      pass = written ? pass : 'conflict';
    }
  }

  for (const entry of listed.value.toSorted((left, right) => left.path.localeCompare(right.path))) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Reads run one at a time to bound open files.
    const refreshed = await refreshFactFile(database, files, entry, stored.get(entry.path));

    if (!refreshed.ok) {
      return refreshed;
    }

    pass = refreshed.value === 'conflict' ? refreshed.value : pass;
  }

  return { ok: true, value: pass };
};

const cursorSnapshot = (database: Database): string =>
  JSON.stringify(
    database
      .query('SELECT path, size, mtime_ms, bytes_read, lines_read FROM fact_files ORDER BY path')
      .all(),
  );

// Reads every fact file first, then replaces all fact rows in one write transaction, so another
// process sees either the old rows or the full new ones, never empty tables. The rows are
// published only if no process indexed a fact file since the read began. Otherwise the new lines
// would be erased, so it reads again.
const rebuildFactsOnce = async (
  database: Database,
  files: FactCacheFiles,
): Promise<Result<Pass, FactFileReason>> => {
  const basis = cursorSnapshot(database);
  const listed = await files.listFactFiles();

  if (!listed.ok) {
    return listed;
  }

  const contents: { entry: FactFileEntry; bytes: Uint8Array }[] = [];

  for (const entry of listed.value.toSorted((left, right) => left.path.localeCompare(right.path))) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Reads run one at a time to bound open files.
    const read = await files.readFactFile(entry.path, 0);

    if (read.ok) {
      contents.push({ entry, bytes: read.value });
    } else if (read.reason.kind !== 'notFound') {
      return read;
    }
  }

  const published = database
    .transaction(() => {
      if (cursorSnapshot(database) !== basis) {
        return false;
      }

      clearFacts(database);

      for (const { entry, bytes } of contents) {
        applyBytes(database, entry, undefined, bytes);
      }

      return true;
    })
    .immediate();

  return { ok: true, value: published ? 'applied' : 'conflict' };
};

export const rebuildFacts = async (
  database: Database,
  files: FactCacheFiles,
): Promise<Result<undefined, FactFileReason>> => {
  for (let attempt = 0; attempt < maximumPasses; attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each pass depends on the rows the last one left.
    const pass = await rebuildFactsOnce(database, files);

    if (!pass.ok) {
      return pass;
    }

    if (pass.value === 'applied') {
      return { ok: true, value: undefined };
    }
  }

  const message = `The fact cache kept changing in another process after ${maximumPasses} rebuilds.`;

  return { ok: false, reason: { kind: 'failed', message } };
};

// A refresh that skipped a moved row did not see the newest lines, so it reads again instead of
// reporting success on stale facts.
export const refreshFacts = async (
  database: Database,
  files: FactCacheFiles,
): Promise<Result<undefined, FactFileReason>> => {
  for (let attempt = 0; attempt < maximumPasses; attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each pass depends on the rows the last one left.
    const pass = await refreshFactsOnce(database, files);

    if (!pass.ok) {
      return pass;
    }

    if (pass.value === 'applied') {
      return { ok: true, value: undefined };
    }
  }

  const message = `The fact cache kept changing in another process after ${maximumPasses} reads.`;

  return { ok: false, reason: { kind: 'failed', message } };
};
