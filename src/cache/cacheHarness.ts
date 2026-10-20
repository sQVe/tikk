import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { invariant } from '../invariant.ts';
import { openCache } from './cache.ts';
import type { CacheFiles, TicketCache } from './cache.ts';

interface FakeFile {
  text: string;
  mtimeMs: number;
  size: number;
}

export interface FakeFiles {
  files: CacheFiles;
  set: (path: string, text: string, mtimeMs?: number) => void;
  remove: (path: string) => void;
  reads: () => number;
  readPaths: () => string[];
}

export interface TicketTextOptions {
  title: string;
  archived?: string;
  parent?: string;
  rank?: number;
  blockedBy?: string[];
}

export const ticketPath = (id: string, project = 'tikk'): string =>
  `/fake/tickets/${project}/${id}-slug.md`;

export const ticketText = ({
  title,
  archived,
  parent,
  rank,
  blockedBy,
}: TicketTextOptions): string => {
  const lines = ['---', 'kind: task', `title: ${title}`, 'project: tikk', 'status: open'];

  if (archived !== undefined) {
    lines.push(`archived: ${archived}`);
  }

  if (parent !== undefined) {
    lines.push(`parent: ${parent}`);
  }

  if (rank !== undefined) {
    lines.push(`rank: ${rank}`);
  }

  if (blockedBy !== undefined) {
    lines.push(`blockedBy: ${JSON.stringify(blockedBy)}`);
  }

  return [...lines, '---', 'Body.\n'].join('\n');
};

export const idsOf = (tickets: { id: string }[]): string[] => tickets.map((ticket) => ticket.id);

export const createFakeFiles = (): FakeFiles => {
  const stored = new Map<string, FakeFile>();
  let clock = 0;
  let readCount = 0;
  const paths: string[] = [];

  const files: CacheFiles = {
    listTicketFiles: () =>
      Promise.resolve({
        ok: true,
        value: [...stored].map(([path, file]) => ({
          path,
          mtimeMs: file.mtimeMs,
          size: file.size,
        })),
      }),
    readTicketFile: (path) => {
      readCount += 1;
      paths.push(path);

      const file = stored.get(path);

      if (file === undefined) {
        return Promise.resolve({
          ok: false,
          reason: { kind: 'notFound', message: `${path} is missing.` },
        });
      }

      const hash = createHash('sha256').update(file.text).digest('hex');

      return Promise.resolve({ ok: true, value: { text: file.text, hash } });
    },
  };

  return {
    files,
    set: (path, text, mtimeMs) => {
      clock += 1;
      stored.set(path, { text, mtimeMs: mtimeMs ?? clock, size: text.length });
    },
    remove: (path) => {
      stored.delete(path);
    },
    reads: () => readCount,
    readPaths: () => paths,
  };
};

export const createDatabaseFixture = async (): Promise<{
  databasePath: string;
  cleanup: () => Promise<void>;
}> => {
  const directory = await mkdtemp(join(tmpdir(), 'tikk-cache-'));

  return {
    databasePath: join(directory, 'nested', 'index.db'),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
};

export const openTestCache = (databasePath: string): TicketCache => {
  const opened = openCache(databasePath);

  invariant(opened.ok, 'The test cache must open.');

  return opened.value;
};

export const runSql = (databasePath: string, sql: string): void => {
  const database = new Database(databasePath);

  database.run(sql);
  database.close();
};

export const rewriteDatabaseText = (databasePath: string, from: string, to: string): void => {
  invariant(from.length === to.length, 'The replacement must keep the file size.');

  const bytes = readFileSync(databasePath);
  const offset = bytes.indexOf(from);

  invariant(offset !== -1, `The database does not contain "${from}".`);

  bytes.write(to, offset);
  writeFileSync(databasePath, bytes);
};
