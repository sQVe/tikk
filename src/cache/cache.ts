import type { Database } from 'bun:sqlite';

import type { Result } from '../result.ts';
import type { TicketId } from '../ticket/ticket.ts';
import { openDatabase } from './cacheSchema.ts';
import { getTicket, listErrors, listTickets } from './ticketQueries.ts';
import type {
  CachedError,
  CachedTicket,
  ListTicketsOptions,
  TicketNotFound,
} from './ticketQueries.ts';
import { refresh } from './ticketScan.ts';
import type { CacheFileReason, CacheFiles } from './ticketScan.ts';

export type {
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

export const openCache = (path: string): TicketCache => new TicketCache(openDatabase(path));
