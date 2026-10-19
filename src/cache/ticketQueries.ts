import type { Database } from 'bun:sqlite';

import { z } from 'zod';

import { invariant } from '../invariant.ts';
import type { Result } from '../result.ts';
import { parseTicketId, ticketFrontMatterSchema } from '../ticket/ticket.ts';
import type { TicketFrontMatter, TicketId } from '../ticket/ticket.ts';

export interface CachedTicket {
  id: TicketId;
  path: string;
  hash: string;
  error: string | null;
  frontMatter: TicketFrontMatter;
  body: string;
}

export interface CachedError {
  path: string;
  message: string;
}

export interface TicketNotFound {
  kind: 'notFound';
  message: string;
}

export interface ListTicketsOptions {
  includeArchived: boolean;
}

const parseBlockedBy = (text: string, context: z.RefinementCtx): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    context.addIssue({ code: 'custom', message: 'blocked_by is not JSON.' });

    return z.NEVER;
  }
};

const ticketRowSchema = z.object({
  id: z.string(),
  path: z.string(),
  hash: z.string(),
  error: z.string().nullable(),
  kind: z.string(),
  title: z.string(),
  project: z.string(),
  parent: z.string().nullable(),
  rank: z.number().nullable(),
  blocked_by: z.string().transform(parseBlockedBy),
  status: z.string(),
  archived: z.string().nullable(),
  body: z.string(),
});

const pathRowSchema = z.object({ path: z.string() });

const errorRowSchema = z.object({ path: z.string(), error: z.string() });

const ticketColumns =
  'id, path, hash, error, kind, title, project, parent, rank, blocked_by, status, archived, body';

const toCachedTicket = (raw: unknown): CachedTicket => {
  const row = ticketRowSchema.safeParse(raw);

  invariant(row.success, 'A cached ticket row does not match the cache schema.');

  const id = parseTicketId(row.data.id);

  invariant(id.ok, 'A cached ticket row has an invalid ID.');

  const frontMatter = ticketFrontMatterSchema.safeParse({
    kind: row.data.kind,
    title: row.data.title,
    project: row.data.project,
    parent: row.data.parent ?? undefined,
    rank: row.data.rank ?? undefined,
    blockedBy: row.data.blocked_by,
    status: row.data.status,
    archived: row.data.archived ?? undefined,
  });

  invariant(frontMatter.success, 'A cached ticket row has invalid front matter.');

  return {
    id: id.value,
    path: row.data.path,
    hash: row.data.hash,
    error: row.data.error,
    frontMatter: frontMatter.data,
    body: row.data.body,
  };
};

export const getTicket = (
  database: Database,
  id: TicketId,
): Result<CachedTicket, TicketNotFound> => {
  const row = database
    .query(`SELECT ${ticketColumns} FROM tickets WHERE id = ? AND title IS NOT NULL`)
    .get(id);

  if (row === null) {
    return {
      ok: false,
      reason: { kind: 'notFound', message: `Ticket ${id} is not in the cache.` },
    };
  }

  return { ok: true, value: toCachedTicket(row) };
};

export const findTicketPath = (
  database: Database,
  id: TicketId,
): Result<string, TicketNotFound> => {
  const row = pathRowSchema.safeParse(
    database
      .query('SELECT path FROM tickets WHERE id = ? ORDER BY title IS NULL, path LIMIT 1')
      .get(id),
  );

  if (!row.success) {
    return {
      ok: false,
      reason: { kind: 'notFound', message: `Ticket ${id} is not in the cache.` },
    };
  }

  return { ok: true, value: row.data.path };
};

export const listTickets = (database: Database, options: ListTicketsOptions): CachedTicket[] => {
  const archivedFilter = options.includeArchived ? '' : 'AND archived IS NULL';

  const rows = database
    .query(
      `SELECT ${ticketColumns} FROM tickets
      WHERE title IS NOT NULL ${archivedFilter}
      ORDER BY project, id`,
    )
    .all();

  return rows.map(toCachedTicket);
};

export const listErrors = (database: Database): CachedError[] => {
  const rows = database
    .query('SELECT path, error FROM tickets WHERE error IS NOT NULL ORDER BY path')
    .all();

  return rows.map((raw) => {
    const row = errorRowSchema.safeParse(raw);

    invariant(row.success, 'A cached error row does not match the cache schema.');

    return { path: row.data.path, message: row.data.error };
  });
};
