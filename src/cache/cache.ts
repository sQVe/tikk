import type { Database } from 'bun:sqlite';

import { invariant } from '../invariant.ts';
import type { Result } from '../result.ts';
import type { TicketId } from '../ticket/ticket.ts';
import { openDatabase } from './cacheSchema.ts';
import type { CacheOpenReason } from './cacheSchema.ts';
import {
  findTicketPath,
  getTicket,
  hasValidRows,
  listErrors,
  listTickets,
} from './ticketQueries.ts';
import type {
  CachedError,
  CachedTicket,
  ListTicketsOptions,
  TicketNotFound,
} from './ticketQueries.ts';
import { hasValidScanRows, refresh } from './ticketScan.ts';
import type { CacheFileReason, CacheFiles } from './ticketScan.ts';

export type {
  CacheOpenReason,
  CachedError,
  CachedTicket,
  CacheFileReason,
  CacheFiles,
  ListTicketsOptions,
  TicketNotFound,
};

const hasValidCache = (database: Database): boolean =>
  hasValidScanRows(database) && hasValidRows(database);

const isSqliteError = (error: unknown): error is Error =>
  error instanceof Error && 'code' in error && String(error.code).startsWith('SQLITE');

export class TicketCache implements Disposable {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async refresh(files: CacheFiles): Promise<Result<undefined, CacheFileReason>> {
    try {
      if (!hasValidCache(this.#database)) {
        this.#database.run('DELETE FROM tickets');
      }

      const refreshed = await refresh(this.#database, files);

      if (refreshed.ok && !hasValidCache(this.#database)) {
        return {
          ok: false,
          reason: {
            kind: 'failed',
            message: 'The cache holds rows it cannot read after a rebuild.',
          },
        };
      }

      return refreshed;
    } catch (error) {
      invariant(isSqliteError(error), 'A refresh failed for a reason other than SQLite.');

      return {
        ok: false,
        reason: { kind: 'failed', message: `The cache failed: ${error.message}` },
      };
    }
  }

  getTicket(id: TicketId): Result<CachedTicket, TicketNotFound> {
    return getTicket(this.#database, id);
  }

  findTicketPath(id: TicketId): Result<string, TicketNotFound> {
    return findTicketPath(this.#database, id);
  }

  listTickets(options: ListTicketsOptions): CachedTicket[] {
    return listTickets(this.#database, options);
  }

  listErrors(): CachedError[] {
    return listErrors(this.#database);
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}

export const openCache = (path: string): Result<TicketCache, CacheOpenReason> => {
  const database = openDatabase(path);

  if (!database.ok) {
    return database;
  }

  return { ok: true, value: new TicketCache(database.value) };
};
