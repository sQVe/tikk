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

const storedFileSchema = z.object({
  path: z.string(),
  size: z.number(),
  mtime_ms: z.number(),
  bytes_read: z.number(),
  lines_read: z.number(),
});

type StoredFile = z.infer<typeof storedFileSchema>;

const newline = 0x0a;

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
        'INSERT OR REPLACE INTO facts (path, line, ticket, kind, at, json) VALUES (?, ?, ?, ?, ?, ?)',
        [path, line, fact.ticket, fact.kind, fact.at, lineText],
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

export const refreshFacts = async (
  database: Database,
  files: FactCacheFiles,
): Promise<Result<undefined, FactFileReason>> => {
  const listed = await files.listFactFiles();

  if (!listed.ok) {
    return listed;
  }

  const stored = loadStoredFiles(database);
  const present = new Set(listed.value.map((entry) => entry.path));

  for (const path of stored.keys()) {
    if (!present.has(path)) {
      deleteFile(database, path);
    }
  }

  for (const entry of listed.value.toSorted((left, right) => left.path.localeCompare(right.path))) {
    const previous = stored.get(entry.path);

    if (isUnchanged(previous, entry)) {
      continue;
    }

    const reread = hasShrunk(previous, entry);
    const base = reread ? undefined : previous;

    // oxlint-disable-next-line eslint/no-await-in-loop -- Reads run one at a time to bound open files.
    const read = await files.readFactFile(entry.path, base?.bytes_read ?? 0);

    if (!read.ok) {
      if (read.reason.kind === 'notFound') {
        deleteFile(database, entry.path);

        continue;
      }

      return read;
    }

    database.transaction(() => {
      if (reread) {
        deleteFile(database, entry.path);
      }

      applyBytes(database, entry, base, read.value);
    })();
  }

  return { ok: true, value: undefined };
};
