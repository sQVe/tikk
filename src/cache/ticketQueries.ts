import type { Database } from 'bun:sqlite';
import { basename, dirname } from 'node:path';

import { z } from 'zod';

import { invariant } from '../invariant.ts';
import type { Result } from '../result.ts';
import {
  parseProjectName,
  parseTicketFileName,
  parseTicketId,
  ticketFrontMatterSchema,
  ticketIdSchema,
} from '../ticket/ticket.ts';
import type { TicketFrontMatter, TicketId } from '../ticket/ticket.ts';

export interface CachedTicket {
  id: TicketId;
  path: string;
  hash: string;
  error: string | null;
  frontMatter: TicketFrontMatter;
  body: string;
}

export interface TicketOutline {
  id: TicketId;
  frontMatter: Pick<TicketFrontMatter, 'kind' | 'status' | 'parent' | 'archived'>;
}

interface ListColumns {
  blockedBy: unknown;
  discoveredFrom: unknown;
  related: unknown;
  criteria: unknown;
  covers: unknown;
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
  blocked_by: z.string(),
  discovered_from: z.string(),
  related: z.string(),
  criteria: z.string().nullable(),
  covers: z.string().nullable(),
  status: z.string(),
  archived: z.string().nullable(),
  new: z.number().nullable(),
  body: z.string(),
});

const pathRowSchema = z.object({ path: z.string() });

const errorRowSchema = z.object({ path: z.string(), error: z.string() });

const ticketColumns =
  'id, path, hash, error, kind, title, project, parent, rank, blocked_by, discovered_from, related, criteria, covers, status, archived, new, body';

const parseOptionalJson = (text: string | null): unknown =>
  text === null ? undefined : (JSON.parse(text) ?? undefined);

// The list columns hold JSON text. A column that is not JSON means the row is damaged.
const parseListColumns = (row: z.output<typeof ticketRowSchema>): ListColumns | undefined => {
  try {
    return {
      blockedBy: JSON.parse(row.blocked_by),
      discoveredFrom: JSON.parse(row.discovered_from),
      related: JSON.parse(row.related),
      criteria: parseOptionalJson(row.criteria),
      covers: parseOptionalJson(row.covers),
    };
  } catch {
    return undefined;
  }
};

const parseCachedTicket = (raw: unknown): CachedTicket | undefined => {
  const row = ticketRowSchema.safeParse(raw);

  if (!row.success) {
    return undefined;
  }

  const id = parseTicketId(row.data.id);

  if (!id.ok) {
    return undefined;
  }

  const lists = parseListColumns(row.data);

  if (lists === undefined) {
    return undefined;
  }

  const frontMatter = ticketFrontMatterSchema.safeParse({
    kind: row.data.kind,
    title: row.data.title,
    project: row.data.project,
    parent: row.data.parent ?? undefined,
    rank: row.data.rank ?? undefined,
    blockedBy: lists.blockedBy,
    discoveredFrom: lists.discoveredFrom,
    related: lists.related,
    criteria: lists.criteria,
    covers: lists.covers,
    status: row.data.status,
    archived: row.data.archived ?? undefined,
    new: row.data.new === 1 ? true : undefined,
  });

  if (!frontMatter.success) {
    return undefined;
  }

  return {
    id: id.value,
    path: row.data.path,
    hash: row.data.hash,
    error: row.data.error,
    frontMatter: frontMatter.data,
    body: row.data.body,
  };
};

const toCachedTicket = (raw: unknown): CachedTicket => {
  const parsed = parseCachedTicket(raw);

  invariant(parsed !== undefined, 'A cached ticket row is invalid.');

  return parsed;
};

const titleOf = z.object({ title: z.string().nullable() });

// A row holds either a ticket that parses, or only an error for a file that never parsed.
const isValidRow = (raw: unknown): boolean => {
  const title = titleOf.safeParse(raw);

  if (!title.success) {
    return false;
  }

  if (title.data.title === null) {
    return errorRowSchema.safeParse(raw).success;
  }

  return parseCachedTicket(raw) !== undefined;
};

export const hasValidRows = (database: Database): boolean =>
  database.query(`SELECT ${ticketColumns} FROM tickets`).all().every(isValidRow);

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

const outlineRowSchema = z.object({
  id: ticketIdSchema,
  kind: ticketFrontMatterSchema.shape.kind,
  status: ticketFrontMatterSchema.shape.status,
  parent: ticketIdSchema.nullable(),
  archived: z.string().nullable(),
});

const toOutline = (raw: unknown): TicketOutline => {
  const row = outlineRowSchema.safeParse(raw);

  invariant(row.success, 'A cached ticket outline row is invalid.');

  const { id, kind, status, parent, archived } = row.data;
  const frontMatter: TicketOutline['frontMatter'] = { kind, status };

  if (parent !== null) {
    frontMatter.parent = parent;
  }

  if (archived !== null) {
    frontMatter.archived = archived;
  }

  return { id, frontMatter };
};

// Reads only the fields that place a ticket in its tree, which is much cheaper than whole tickets.
// A ticket whose file has an error is left out, since its cached fields are stale.
export const listTicketOutlines = (database: Database): TicketOutline[] =>
  database
    .query(
      `SELECT id, kind, status, parent, archived FROM tickets
      WHERE title IS NOT NULL AND error IS NULL
      ORDER BY project, id`,
    )
    .all()
    .map(toOutline);

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

export const isIdShared = (database: Database, id: TicketId): boolean => {
  const project = parseProjectName(id.slice(0, -'-XXXX'.length));

  if (!project.ok) {
    return false;
  }

  const rows = z
    .array(z.object({ path: z.string() }))
    .parse(database.query('SELECT path FROM tickets WHERE path LIKE ?').all(`%/${id}-%`));

  const named = rows.filter((row) => {
    const inProjectFolder = basename(dirname(row.path)) === project.value;
    const fileName = parseTicketFileName(basename(row.path), project.value);

    return inProjectFolder && fileName.ok && fileName.value.id === id;
  });

  return named.length > 1;
};
