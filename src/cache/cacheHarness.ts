import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Fact } from '../fact/fact.ts';
import { invariant } from '../invariant.ts';
import type { TicketId } from '../ticket/ticket.ts';
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
  setFactFile: (path: string, text: string, mtimeMs?: number) => void;
  removeFactFile: (path: string) => void;
  factReads: () => { path: string; fromByte: number }[];
  reads: () => number;
  readPaths: () => string[];
}

interface Gate {
  reached: Promise<void>;
  open: () => void;
  wait: () => Promise<void>;
}

export interface TicketTextOptions {
  title: string;
  archived?: string;
  parent?: string;
  rank?: number;
  blockedBy?: string[];
}

export const factPath = (machine = 'laptop', month = '2026-10'): string =>
  `/fake/facts/${machine}/${month}.jsonl`;

export const factText = (
  ticket: string,
  extra?: Record<string, unknown>,
  at = '2026-10-20T10:00:00.000Z',
): string => {
  const body = extra ?? { kind: 'accept' };

  return `${JSON.stringify({ version: 1, ticket, at, machine: 'laptop', ...body })}\n`;
};

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
  const factFiles = new Map<string, { bytes: Buffer; mtimeMs: number }>();
  const factReads: { path: string; fromByte: number }[] = [];

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
    listFactFiles: () =>
      Promise.resolve({
        ok: true,
        value: [...factFiles].map(([path, file]) => ({
          path,
          mtimeMs: file.mtimeMs,
          size: file.bytes.length,
        })),
      }),
    readFactFile: (path, fromByte) => {
      factReads.push({ path, fromByte });

      const file = factFiles.get(path);

      if (file === undefined) {
        return Promise.resolve({
          ok: false,
          reason: { kind: 'notFound', message: `${path} is missing.` },
        });
      }

      return Promise.resolve({ ok: true, value: file.bytes.subarray(fromByte) });
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
    setFactFile: (path, text, mtimeMs) => {
      clock += 1;
      factFiles.set(path, { bytes: Buffer.from(text), mtimeMs: mtimeMs ?? clock });
    },
    removeFactFile: (path) => {
      factFiles.delete(path);
    },
    factReads: () => factReads,
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

export const factsOf = (cache: TicketCache, ticketIds?: TicketId[]): Fact[] => {
  const listed = cache.listFacts(ticketIds);

  invariant(listed.ok, 'The test facts must decode.');

  return listed.value;
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

// Pauses a fake file call until the test opens the gate, so two refreshes can interleave.
export const makeGate = (): Gate => {
  const reached = Promise.withResolvers<undefined>();
  const opened = Promise.withResolvers<undefined>();

  return {
    reached: reached.promise,
    open: () => {
      opened.resolve(undefined);
    },
    wait: () => {
      reached.resolve(undefined);

      return opened.promise;
    },
  };
};
