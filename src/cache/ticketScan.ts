import type { Database } from 'bun:sqlite';
import { basename, dirname } from 'node:path';

import { z } from 'zod';

import type { Result } from '../result.ts';
import { parseProjectName, parseTicketFile, parseTicketFileName } from '../ticket/ticket.ts';
import type { TicketFile } from '../ticket/ticket.ts';
import type { FactCacheFiles } from './factScan.ts';

interface CacheFileEntry {
  path: string;
  mtimeMs: number;
  size: number;
}

interface CacheFileContent {
  text: string;
  hash: string;
}

export interface CacheFileReason {
  kind: 'notFound' | 'changedOnDisk' | 'failed';
  message: string;
}

export interface CacheFiles extends FactCacheFiles {
  listTicketFiles: () => Promise<Result<CacheFileEntry[], CacheFileReason>>;
  readTicketFile: (path: string) => Promise<Result<CacheFileContent, CacheFileReason>>;
}

type ReadOutcome =
  | { kind: 'content'; entry: CacheFileEntry; content: CacheFileContent }
  | { kind: 'unreadable'; entry: CacheFileEntry; message: string };

interface ParsedTicket {
  id: string;
  file: TicketFile;
}

type Pass = 'applied' | 'conflict';

const forceRescan = { mtimeMs: -1, hash: '' };

const storedRowSchema = z.object({
  path: z.string(),
  mtime_ms: z.number(),
  size: z.number(),
  hash: z.string(),
});

type StoredRow = z.infer<typeof storedRowSchema>;

export const hasValidScanRows = (database: Database): boolean =>
  z
    .array(storedRowSchema)
    .safeParse(database.query('SELECT path, mtime_ms, size, hash FROM tickets').all()).success;

const loadRows = (database: Database): Map<string, StoredRow> => {
  const rows = z
    .array(storedRowSchema)
    .parse(database.query('SELECT path, mtime_ms, size, hash FROM tickets').all());

  const stored = new Map<string, StoredRow>();

  for (const row of rows) {
    stored.set(row.path, row);
  }

  return stored;
};

const isSameRow = (left: StoredRow | undefined, right: StoredRow | undefined): boolean =>
  left?.mtime_ms === right?.mtime_ms && left?.size === right?.size && left?.hash === right?.hash;

const isUnchanged = (row: StoredRow | undefined, entry: CacheFileEntry): boolean =>
  row?.mtime_ms === entry.mtimeMs && row.size === entry.size;

const readChanged = async (
  files: CacheFiles,
  entries: CacheFileEntry[],
  stored: Map<string, StoredRow>,
): Promise<{ outcomes: ReadOutcome[]; vanished: Set<string> }> => {
  const outcomes: ReadOutcome[] = [];
  const vanished = new Set<string>();

  for (const entry of entries) {
    if (isUnchanged(stored.get(entry.path), entry)) {
      continue;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- Reads run one at a time to bound open files.
    const read = await files.readTicketFile(entry.path);

    if (read.ok) {
      outcomes.push({ kind: 'content', entry, content: read.value });
    } else if (read.reason.kind === 'notFound') {
      vanished.add(entry.path);
    } else {
      outcomes.push({ kind: 'unreadable', entry, message: read.reason.message });
    }
  }

  return { outcomes, vanished };
};

const parseContent = (
  entry: CacheFileEntry,
  text: string,
): Result<ParsedTicket, { message: string }> => {
  const projectName = parseProjectName(basename(dirname(entry.path)));

  if (!projectName.ok) {
    return { ok: false, reason: projectName.reason };
  }

  const fileName = parseTicketFileName(basename(entry.path), projectName.value);

  if (!fileName.ok) {
    return { ok: false, reason: fileName.reason };
  }

  const file = parseTicketFile(text);

  if (!file.ok) {
    return { ok: false, reason: file.reason };
  }

  return { ok: true, value: { id: fileName.value.id, file: file.value } };
};

const fileNameId = (entry: CacheFileEntry): string | null => {
  const projectName = parseProjectName(basename(dirname(entry.path)));

  if (!projectName.ok) {
    return null;
  }

  const fileName = parseTicketFileName(basename(entry.path), projectName.value);

  return fileName.ok ? fileName.value.id : null;
};

const recordError = (
  database: Database,
  entry: CacheFileEntry,
  hash: string,
  message: string,
): void => {
  database.run(
    `INSERT INTO tickets (path, mtime_ms, size, hash, id, error) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (path) DO UPDATE SET
      mtime_ms = excluded.mtime_ms,
      size = excluded.size,
      hash = excluded.hash,
      id = excluded.id,
      error = excluded.error`,
    [entry.path, entry.mtimeMs, entry.size, hash, fileNameId(entry), message],
  );
};

const recordTicket = (
  database: Database,
  entry: CacheFileEntry,
  hash: string,
  ticket: ParsedTicket,
): void => {
  const { frontMatter, body } = ticket.file;

  database.run(
    `INSERT INTO tickets (
      path, mtime_ms, size, hash, id, kind, title, project, parent, rank,
      blocked_by, status, archived, body, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT (path) DO UPDATE SET
      mtime_ms = excluded.mtime_ms,
      size = excluded.size,
      hash = excluded.hash,
      id = excluded.id,
      kind = excluded.kind,
      title = excluded.title,
      project = excluded.project,
      parent = excluded.parent,
      rank = excluded.rank,
      blocked_by = excluded.blocked_by,
      status = excluded.status,
      archived = excluded.archived,
      body = excluded.body,
      error = NULL`,
    [
      entry.path,
      entry.mtimeMs,
      entry.size,
      hash,
      ticket.id,
      frontMatter.kind,
      frontMatter.title,
      frontMatter.project,
      frontMatter.parent ?? null,
      frontMatter.rank ?? null,
      JSON.stringify(frontMatter.blockedBy),
      frontMatter.status,
      frontMatter.archived ?? null,
      body,
    ],
  );
};

const applyContent = (
  database: Database,
  row: StoredRow | undefined,
  entry: CacheFileEntry,
  content: CacheFileContent,
): void => {
  if (row?.hash === content.hash) {
    database.run('UPDATE tickets SET mtime_ms = ?, size = ? WHERE path = ?', [
      entry.mtimeMs,
      entry.size,
      entry.path,
    ]);

    return;
  }

  const parsed = parseContent(entry, content.text);

  if (parsed.ok) {
    recordTicket(database, entry, content.hash, parsed.value);
  } else {
    recordError(database, entry, content.hash, parsed.reason.message);
  }
};

const applyOutcome = (
  database: Database,
  basis: StoredRow | undefined,
  outcome: ReadOutcome,
): void => {
  if (outcome.kind === 'content') {
    applyContent(database, basis, outcome.entry, outcome.content);

    return;
  }

  const entry = { ...outcome.entry, mtimeMs: forceRescan.mtimeMs };

  recordError(database, entry, forceRescan.hash, outcome.message);
};

const maximumPasses = 5;

const deleteMissing = (
  database: Database,
  deleted: string[],
  stored: Map<string, StoredRow>,
  current: Map<string, StoredRow>,
): Pass => {
  let pass: Pass = 'applied';

  for (const path of deleted) {
    if (isSameRow(current.get(path), stored.get(path))) {
      database.run('DELETE FROM tickets WHERE path = ?', [path]);
    } else {
      pass = 'conflict';
    }
  }

  return pass;
};

const markDuplicates = (database: Database): void => {
  const rows = z
    .array(z.object({ path: z.string(), id: z.string() }))
    .parse(
      database.query('SELECT path, id FROM tickets WHERE title IS NOT NULL ORDER BY path').all(),
    );

  const owners = new Map<string, string>();

  for (const row of rows) {
    const owner = owners.get(row.id);

    if (owner === undefined) {
      owners.set(row.id, row.path);

      continue;
    }

    database.run(
      `UPDATE tickets SET
        id = NULL, kind = NULL, title = NULL, project = NULL, parent = NULL, rank = NULL,
        blocked_by = NULL, status = NULL, archived = NULL, body = NULL,
        mtime_ms = ?, hash = ?, error = ?
      WHERE path = ?`,
      [
        forceRescan.mtimeMs,
        forceRescan.hash,
        `Ticket ID ${row.id} is already used by ${owner}.`,
        row.path,
      ],
    );
  }
};

const refreshOnce = async (
  database: Database,
  files: CacheFiles,
): Promise<Result<Pass, CacheFileReason>> => {
  // The rows load before the listing, so a row written by another process after this point is not
  // in the basis, and this refresh does not overwrite or delete it.
  const stored = loadRows(database);
  const listed = await files.listTicketFiles();

  if (!listed.ok) {
    return listed;
  }

  const entries = listed.value.toSorted((left, right) => left.path.localeCompare(right.path));
  const { outcomes, vanished } = await readChanged(files, entries, stored);
  const present = new Set(entries.map((entry) => entry.path));

  for (const path of vanished) {
    present.delete(path);
  }

  const deleted = [...stored.keys()].filter((path) => !present.has(path));

  if (outcomes.length === 0 && deleted.length === 0) {
    return { ok: true, value: 'applied' };
  }

  // Another process may refresh the same cache at the same time. A change applies only when the
  // row still matches the one this refresh started from, so an older refresh never undoes a newer
  // one.
  const pass = database
    .transaction((): Pass => {
      const current = loadRows(database);
      let applied: Pass = 'applied';

      for (const outcome of outcomes) {
        const basis = stored.get(outcome.entry.path);

        if (isSameRow(current.get(outcome.entry.path), basis)) {
          applyOutcome(database, basis, outcome);
        } else {
          applied = 'conflict';
        }
      }

      const deletions = deleteMissing(database, deleted, stored, current);

      markDuplicates(database);

      return deletions === 'conflict' ? deletions : applied;
    })
    .immediate();

  return { ok: true, value: pass };
};

// A refresh that skipped a moved row did not see the newest file, so it reads again instead of
// reporting success on stale rows.
export const refresh = async (
  database: Database,
  files: CacheFiles,
): Promise<Result<undefined, CacheFileReason>> => {
  for (let attempt = 0; attempt < maximumPasses; attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each pass depends on the rows the last one left.
    const pass = await refreshOnce(database, files);

    if (!pass.ok) {
      return pass;
    }

    if (pass.value === 'applied') {
      return { ok: true, value: undefined };
    }
  }

  const message = `The ticket cache kept changing in another process after ${maximumPasses} reads.`;

  return { ok: false, reason: { kind: 'failed', message } };
};
