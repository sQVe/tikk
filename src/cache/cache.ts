import type { Database } from 'bun:sqlite';

import type { Fact } from '../fact/fact.ts';
import { invariant } from '../invariant.ts';
import type { Result } from '../result.ts';
import type { TicketId } from '../ticket/ticket.ts';
import { mayHaveArchiveWork } from './archiveQueries.ts';
import { openDatabase } from './cacheSchema.ts';
import type { CacheOpenReason } from './cacheSchema.ts';
import {
  hasValidFactErrorRows,
  listArchiveFacts,
  listFactErrors,
  listFacts,
  listStateFacts,
} from './factQueries.ts';
import type { FactDamage } from './factQueries.ts';
import { hasValidFactCursors, rebuildFacts, refreshFacts } from './factScan.ts';
import {
  findTicketPath,
  getTicket,
  hasValidRows,
  listErrors,
  listTicketOutlines,
  listTickets,
} from './ticketQueries.ts';
import type {
  CachedError,
  CachedTicket,
  ListTicketsOptions,
  TicketNotFound,
  TicketOutline,
} from './ticketQueries.ts';
import { hasValidScanRows, refresh } from './ticketScan.ts';
import type { CacheFileReason, CacheFiles } from './ticketScan.ts';

interface CacheQueryFailure {
  kind: 'failed';
  message: string;
}

export type {
  CacheOpenReason,
  FactDamage,
  CachedError,
  CachedTicket,
  CacheFileReason,
  CacheFiles,
  ListTicketsOptions,
  TicketNotFound,
  TicketOutline,
};

const hasValidTickets = (database: Database): boolean =>
  hasValidScanRows(database) && hasValidRows(database);

const hasValidFacts = (database: Database): boolean =>
  hasValidFactCursors(database) && hasValidFactErrorRows(database);

// Moves when this connection writes (total_changes) or another connection commits (data_version).
const writeMarker = (database: Database): string => {
  const changes = database
    .query<{ changes: number }, []>('SELECT total_changes() AS changes')
    .get();

  const version = database.query<{ data_version: number }, []>('PRAGMA data_version').get();

  invariant(changes !== null && version !== null, 'The write marker is missing.');

  return `${changes.changes}:${version.data_version}`;
};

const isSqliteError = (error: unknown): error is Error =>
  error instanceof Error && 'code' in error && String(error.code).startsWith('SQLITE');

const queryFailure = (error: unknown): CacheQueryFailure => {
  invariant(isSqliteError(error), 'A cache query failed for a reason other than SQLite.');

  return { kind: 'failed', message: `The cache failed: ${error.message}` };
};

const readValue = <Value>(read: () => Value): Result<Value, CacheQueryFailure> => {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    return { ok: false, reason: queryFailure(error) };
  }
};

const readResult = <Value, Reason>(
  read: () => Result<Value, Reason>,
): Result<Value, Reason | CacheQueryFailure> => {
  try {
    return read();
  } catch (error) {
    return { ok: false, reason: queryFailure(error) };
  }
};

export class TicketCache implements Disposable {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async refresh(files: CacheFiles): Promise<Result<undefined, CacheFileReason>> {
    try {
      const markerBefore = writeMarker(this.#database);
      const ticketsWereValid = hasValidTickets(this.#database);

      if (!ticketsWereValid) {
        this.#database.run('DELETE FROM tickets');
      }

      if (!hasValidFacts(this.#database)) {
        const rebuilt = await rebuildFacts(this.#database, files);

        if (!rebuilt.ok) {
          return rebuilt;
        }
      }

      const refreshed = await refresh(this.#database, files);

      if (!refreshed.ok) {
        return refreshed;
      }

      const refreshedFacts = await refreshFacts(this.#database, files);

      if (!refreshedFacts.ok) {
        return refreshedFacts;
      }

      // Rows that passed the check before the refresh are still valid when nothing wrote to the
      // database since, from this connection or another one.
      const ticketsUntouched = ticketsWereValid && writeMarker(this.#database) === markerBefore;
      const ticketsValid = ticketsUntouched || hasValidTickets(this.#database);

      if (!ticketsValid || !hasValidFacts(this.#database)) {
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
      return { ok: false, reason: queryFailure(error) };
    }
  }

  getTicket(id: TicketId): Result<CachedTicket, TicketNotFound | CacheQueryFailure> {
    return readResult(() => getTicket(this.#database, id));
  }

  findTicketPath(id: TicketId): Result<string, TicketNotFound | CacheQueryFailure> {
    return readResult(() => findTicketPath(this.#database, id));
  }

  listTickets(options: ListTicketsOptions): Result<CachedTicket[], CacheQueryFailure> {
    return readValue(() => listTickets(this.#database, options));
  }

  listTicketOutlines(): Result<TicketOutline[], CacheQueryFailure> {
    return readValue(() => listTicketOutlines(this.#database));
  }

  mayHaveArchiveWork(now: Date): Result<boolean, CacheQueryFailure> {
    return readValue(() => mayHaveArchiveWork(this.#database, now));
  }

  listFacts(ticketIds?: TicketId[]): Result<Fact[], FactDamage | CacheQueryFailure> {
    return readResult(() => listFacts(this.#database, ticketIds));
  }

  listStateFacts(ticketIds?: TicketId[]): Result<Fact[], FactDamage | CacheQueryFailure> {
    return readResult(() => listStateFacts(this.#database, ticketIds));
  }

  listArchiveFacts(): Result<Fact[], FactDamage | CacheQueryFailure> {
    return readResult(() => listArchiveFacts(this.#database));
  }

  // Replaces every fact row from the files in one transaction.
  async rebuildFacts(files: CacheFiles): Promise<Result<undefined, CacheFileReason>> {
    try {
      return await rebuildFacts(this.#database, files);
    } catch (error) {
      return { ok: false, reason: queryFailure(error) };
    }
  }

  listErrors(): Result<CachedError[], CacheQueryFailure> {
    return readValue(() => [...listErrors(this.#database), ...listFactErrors(this.#database)]);
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}

export const openCache = (
  path: string,
  busyTimeoutMilliseconds?: number,
): Result<TicketCache, CacheOpenReason> => {
  const database = openDatabase(path, busyTimeoutMilliseconds);

  if (!database.ok) {
    return database;
  }

  return { ok: true, value: new TicketCache(database.value) };
};
