import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { openCache } from './cache/cache.ts';
import type { CacheFiles, TicketCache } from './cache/cache.ts';
import type { CliEffects, CliSession } from './cli/cli.ts';
import type { Result } from './result.ts';
import {
  acquireStoreLock,
  appendFact,
  createTicketFile,
  listFactFiles,
  listTicketFiles,
  openStore,
  readFactFile,
  readTicketFile,
  storeLog,
  ticketFolderPath,
  tryStoreLock,
  writeTicketFile,
} from './store/store.ts';
import type { Store } from './store/store.ts';
import {
  factFiles,
  logFiles,
  openFailureCode,
  storeFiles,
  storeLock,
  ticketFiles,
} from './storeEffects.ts';
import type { TicketId } from './ticket/ticket.ts';

// A stored fact that does not decode means the cache is damaged. The fact tables are cleared and
// indexed again from the files once. A second failure is reported, not retried.
export const listFactsRecovering = async (
  cache: Pick<TicketCache, 'rebuildFacts'>,
  files: CacheFiles,
  read: (ticketIds?: TicketId[]) => ReturnType<TicketCache['listFacts']>,
  ticketIds?: TicketId[],
): ReturnType<CliSession['listFacts']> => {
  const first = read(ticketIds);

  if (first.ok || first.reason.kind === 'failed') {
    return first;
  }

  const refreshed = await cache.rebuildFacts(files);

  if (!refreshed.ok) {
    return refreshed;
  }

  const second = read(ticketIds);

  return second.ok ? second : { ok: false, reason: { message: second.reason.message } };
};

const isFolderFileEntry = (entry: Dirent): boolean => entry.isFile() || entry.isSymbolicLink();

const listTicketFolderFiles = async (
  folder: string,
): Promise<Result<string[], { message: string }>> => {
  try {
    const entries = await readdir(folder, { recursive: true, withFileTypes: true });

    const files = entries
      .filter((entry) => isFolderFileEntry(entry))
      .map((entry) => relative(folder, join(entry.parentPath, entry.name)));

    return { ok: true, value: files.toSorted() };
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';

    if (missing) {
      return { ok: true, value: [] };
    }

    return { ok: false, reason: { message: `Cannot list the files in ${folder}.` } };
  }
};

// Two ticket files with one ID make a fact for it ambiguous, so the write waits for `tikk sync`.
const checkIdUnshared = (
  cache: TicketCache,
  id: TicketId,
): ReturnType<CliSession['checkIdUnshared']> =>
  cache.isIdShared(id)
    ? {
        ok: false,
        reason: {
          kind: 'shared',
          message: `Ticket ID ${id} is shared by two ticket files. Run tikk sync to resolve it.`,
        },
      }
    : { ok: true, value: undefined };

const sessionFor = (store: Store, cache: TicketCache): CliSession => {
  const files: CacheFiles = {
    listTicketFiles: () => listTicketFiles(ticketFiles, store),
    readTicketFile: (path) => readTicketFile(ticketFiles, path),
    listFactFiles: () => listFactFiles(factFiles, store),
    readFactFile: (path, fromByte) => readFactFile(factFiles, path, fromByte),
  };

  return {
    refresh: () => cache.refresh(files),
    getTicket: (id) => cache.getTicket(id),
    findTicketPath: (id) => cache.findTicketPath(id),
    listTickets: (options) => cache.listTickets(options),
    listTicketOutlines: () => cache.listTicketOutlines(),
    mayHaveArchiveWork: (now) => cache.mayHaveArchiveWork(now),
    listErrors: () => cache.listErrors(),
    listTicketFolderFiles: (project, id) =>
      listTicketFolderFiles(ticketFolderPath(store, project, id)),
    listFacts: (ticketIds) =>
      listFactsRecovering(cache, files, (ids) => cache.listFacts(ids), ticketIds),
    listStateFacts: (ticketIds) =>
      listFactsRecovering(cache, files, (ids) => cache.listStateFacts(ids), ticketIds),
    listArchiveFacts: () => listFactsRecovering(cache, files, () => cache.listArchiveFacts()),
    lockStore: () => acquireStoreLock(storeLock, store),
    tryLockStore: () => tryStoreLock(storeLock, store),
    checkIdUnshared: (id) => checkIdUnshared(cache, id),
    appendFact: async (machine, fact) => {
      const unshared = checkIdUnshared(cache, fact.ticket);

      if (!unshared.ok) {
        return unshared;
      }

      return appendFact(factFiles, store, machine, fact);
    },
    storeLog: async (text) => {
      const stored = await storeLog(logFiles, store, text);

      return stored.ok ? stored : { ok: false, reason: { message: stored.reason.message } };
    },
    createTicketFile: (project, title, text) =>
      createTicketFile(ticketFiles, store, project, title, text),
    writeTicketFile: (path, expectedHash, text) =>
      writeTicketFile(ticketFiles, path, expectedHash, text),
    [Symbol.dispose]: () => {
      cache[Symbol.dispose]();
    },
  };
};

export const createOpenSession =
  (storeRoot: string, cachePath: string): CliEffects['openSession'] =>
  async () => {
    const store = await openStore(storeRoot, storeFiles);

    if (store.ok) {
      const cache = openCache(cachePath);

      if (!cache.ok) {
        return { ok: false, reason: { code: 'storeError', message: cache.reason.message } };
      }

      return { ok: true, value: sessionFor(store.value, cache.value) };
    }

    const code = openFailureCode(storeRoot);

    return { ok: false, reason: { code, message: store.reason.message } };
  };
