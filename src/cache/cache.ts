import type { Database } from 'bun:sqlite';

import type { Result } from '../result.ts';
import type { TicketId } from '../ticket/ticket.ts';
import { openDatabase } from './cacheSchema.ts';
import type { CacheOpenReason } from './cacheSchema.ts';
import { findTicketPath, getTicket, listErrors, listTickets } from './ticketQueries.ts';
import type {
  CachedError,
  CachedTicket,
  ListTicketsOptions,
  TicketNotFound,
} from './ticketQueries.ts';
import { refresh } from './ticketScan.ts';
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

export class TicketCache implements Disposable {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  refresh(files: CacheFiles): Promise<Result<undefined, CacheFileReason>> {
    return refresh(this.#database, files);
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
