import { createHash } from 'node:crypto';
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
  set: (path: string, text: string) => void;
  remove: (path: string) => void;
  reads: () => number;
}

export interface TicketTextOptions {
  title: string;
  archived?: string;
}

export const ticketPath = (id: string, project = 'tikk'): string =>
  `/fake/tickets/${project}/${id}-slug.md`;

export const ticketText = ({ title, archived }: TicketTextOptions): string => {
  const lines = ['---', 'kind: task', `title: ${title}`, 'project: tikk', 'status: open'];

  if (archived !== undefined) {
    lines.push(`archived: ${archived}`);
  }

  return [...lines, '---', 'Body.\n'].join('\n');
};

export const idsOf = (tickets: { id: string }[]): string[] => tickets.map((ticket) => ticket.id);

export const createFakeFiles = (): FakeFiles => {
  const stored = new Map<string, FakeFile>();
  let clock = 0;
  let readCount = 0;

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
    set: (path, text) => {
      clock += 1;
      stored.set(path, { text, mtimeMs: clock, size: text.length });
    },
    remove: (path) => {
      stored.delete(path);
    },
    reads: () => readCount,
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
