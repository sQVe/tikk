import type { Database } from 'bun:sqlite';

import { z } from 'zod';

import { parseFactLine } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import { invariant } from '../invariant.ts';
import type { TicketId } from '../ticket/ticket.ts';
import type { CachedError } from './ticketQueries.ts';

interface PlacedFact {
  fact: Fact;
  path: string;
  line: number;
}

const factRowSchema = z.object({ path: z.string(), line: z.number(), json: z.string() });

const errorRowSchema = z.object({ path: z.string(), line: z.number(), message: z.string() });

const compareText = (left: string, right: string): number =>
  left < right ? -1 : Number(left > right);

const comparePlaced = (left: PlacedFact, right: PlacedFact): number =>
  Date.parse(left.fact.at) - Date.parse(right.fact.at) ||
  compareText(left.path, right.path) ||
  left.line - right.line;

const placeFact = (raw: unknown): PlacedFact => {
  const row = factRowSchema.safeParse(raw);

  invariant(row.success, 'A cached fact row does not match the cache schema.');

  const parsed = parseFactLine(row.data.json);

  invariant(parsed.ok, 'A cached fact line is invalid.');

  return { fact: parsed.value, path: row.data.path, line: row.data.line };
};

export const listFacts = (database: Database, ticketIds?: TicketId[]): Fact[] => {
  const rows =
    ticketIds === undefined
      ? database.query('SELECT path, line, json FROM facts').all()
      : database
          .query(
            `SELECT path, line, json FROM facts
            WHERE ticket IN (SELECT value FROM json_each(?))`,
          )
          .all(JSON.stringify(ticketIds));

  return rows
    .map(placeFact)
    .toSorted(comparePlaced)
    .map((placed) => placed.fact);
};

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
