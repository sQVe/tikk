import type { Database } from 'bun:sqlite';

import { z } from 'zod';

import { parseFactLine } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import { invariant } from '../invariant.ts';
import type { Result } from '../result.ts';
import type { TicketId } from '../ticket/ticket.ts';
import type { CachedError } from './ticketQueries.ts';

interface PlacedFact {
  fact: Fact;
  time: number;
  path: string;
  line: number;
}

// SQLite does not enforce column types, so a row can hold other values than these.
interface FactRow {
  path: unknown;
  line: unknown;
  json: unknown;
}

export interface FactDamage {
  kind: 'damaged';
  message: string;
}

const errorRowSchema = z.object({ path: z.string(), line: z.number(), message: z.string() });

const compareText = (left: string, right: string): number =>
  left < right ? -1 : Number(left > right);

const comparePlaced = (left: PlacedFact, right: PlacedFact): number =>
  left.time - right.time || compareText(left.path, right.path) || left.line - right.line;

const damaged = (message: string): { ok: false; reason: FactDamage } => ({
  ok: false,
  reason: { kind: 'damaged', message },
});

// The scan stores only lines that passed the fact schema, so a row that does not decode means the
// cache was damaged. A full decode of every fact on each refresh is too slow, so a query finds the
// damage when it reads the rows, and the caller rebuilds the fact tables from the files.
const placeFact = (row: FactRow): Result<PlacedFact, FactDamage> => {
  const { path, line, json } = row;

  if (typeof path !== 'string' || typeof line !== 'number' || typeof json !== 'string') {
    return damaged('A cached fact row has a value of the wrong type.');
  }

  const parsed = parseFactLine(json);

  if (!parsed.ok) {
    return damaged(`The cached fact at ${path}:${line} is invalid: ${parsed.reason.message}`);
  }

  return {
    ok: true,
    value: {
      fact: parsed.value,
      time: Date.parse(parsed.value.at),
      path,
      line,
    },
  };
};

const damagedErrorSql = `SELECT 1 FROM fact_errors
  WHERE typeof(path) != 'text' OR typeof(line) != 'integer' OR typeof(message) != 'text'
  LIMIT 1`;

export const hasValidFactErrorRows = (database: Database): boolean =>
  database.query(damagedErrorSql).get() === null;

// Only these facts decide a ticket's state. Progress notes and questions are the bulk of a history,
// and no state reads them.
const stateFactsSql = `(kind IN ('claim', 'release', 'accept', 'reject', 'status', 'unarchive', 'pr',
  'audit') OR (kind = 'log' AND log_type = 'submitted'))`;

// Only these facts date when a ticket finished or was unarchived. An accept counts only after the
// submission it names, so the submissions come too.
const archiveFactsSql = `(kind IN ('accept', 'status', 'unarchive') OR (kind = 'log' AND log_type = 'submitted'))`;

const readFacts = (
  database: Database,
  ticketIds: TicketId[] | undefined,
  kindFilter: string | undefined,
): Result<Fact[], FactDamage> => {
  const conditions: string[] = [];
  const parameters: string[] = [];

  if (ticketIds !== undefined) {
    conditions.push('ticket IN (SELECT value FROM json_each(?))');
    parameters.push(JSON.stringify(ticketIds));
  }

  if (kindFilter !== undefined) {
    conditions.push(kindFilter);
  }

  const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;

  const rows = database
    .query<FactRow, string[]>(`SELECT path, line, json FROM facts${where}`)
    .all(...parameters);

  const placed: PlacedFact[] = [];

  for (const raw of rows) {
    const row = placeFact(raw);

    if (!row.ok) {
      return row;
    }

    placed.push(row.value);
  }

  return { ok: true, value: placed.toSorted(comparePlaced).map((item) => item.fact) };
};

export const listFacts = (database: Database, ticketIds?: TicketId[]): Result<Fact[], FactDamage> =>
  readFacts(database, ticketIds, undefined);

export const listStateFacts = (
  database: Database,
  ticketIds?: TicketId[],
): Result<Fact[], FactDamage> => readFacts(database, ticketIds, stateFactsSql);

export const listArchiveFacts = (database: Database): Result<Fact[], FactDamage> =>
  readFacts(database, undefined, archiveFactsSql);

export const listFactErrors = (database: Database): CachedError[] => {
  const rows = database
    .query('SELECT path, line, message FROM fact_errors ORDER BY path, line')
    .all();

  return rows.map((raw) => {
    const row = errorRowSchema.safeParse(raw);

    invariant(row.success, 'A cached fact error row does not match the cache schema.');

    return { path: `${row.data.path}:${row.data.line}`, message: row.data.message };
  });
};
