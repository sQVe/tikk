import { z } from 'zod';

import type { Result } from '../result.ts';

export interface TicketIdReason {
  message: string;
}

export interface TicketFileName {
  id: TicketId;
  slug: string;
}

export interface TicketIdReason {
  message: string;
}

export interface TicketFileName {
  id: TicketId;
  slug: string;
}

const idAlphabet = '346789abcdefghijkmnpqrtwxyz';
const idLength = 4;

export const projectNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Project name must match ^[a-z0-9][a-z0-9-]*$.')
  .brand<'ProjectName'>();

export const ticketIdSchema = z
  .string()
  .regex(
    new RegExp(`^[a-z0-9][a-z0-9-]*-[${idAlphabet}]{${idLength}}$`),
    `Ticket ID must be a project name, "-", and ${idLength} characters from "${idAlphabet}".`,
  )
  .brand<'TicketId'>();

export type ProjectName = z.output<typeof projectNameSchema>;

export type TicketId = z.output<typeof ticketIdSchema>;

const parseWith = <Schema extends z.ZodType>(
  schema: Schema,
  value: string,
): Result<z.output<Schema>, TicketIdReason> => {
  const parsed = schema.safeParse(value);

  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }

  const message = parsed.error.issues[0]?.message ?? 'Invalid value.';

  return { ok: false, reason: { message: `"${value}": ${message}` } };
};

export const parseProjectName = (value: string): Result<ProjectName, TicketIdReason> =>
  parseWith(projectNameSchema, value);

export const parseTicketId = (value: string): Result<TicketId, TicketIdReason> =>
  parseWith(ticketIdSchema, value);

export const parseTicketFileName = (
  fileName: string,
  project: ProjectName,
): Result<TicketFileName, TicketIdReason> => {
  if (!fileName.endsWith('.md')) {
    return { ok: false, reason: { message: `File name "${fileName}" must end in .md.` } };
  }

  const stem = fileName.slice(0, -'.md'.length);
  const prefix = `${project}-`;

  if (!stem.startsWith(prefix)) {
    return {
      ok: false,
      reason: { message: `File name "${fileName}" must start with "${prefix}".` },
    };
  }

  const idEnd = prefix.length + idLength;
  const parsedId = parseTicketId(stem.slice(0, idEnd));

  if (!parsedId.ok) {
    return parsedId;
  }

  if (stem[idEnd] !== '-') {
    return {
      ok: false,
      reason: { message: `File name "${fileName}" must have "-" and a slug after the ID.` },
    };
  }

  const slug = stem.slice(idEnd + 1);

  if (slug === '') {
    return { ok: false, reason: { message: `File name "${fileName}" has an empty slug.` } };
  }

  return { ok: true, value: { id: parsedId.value, slug } };
};
