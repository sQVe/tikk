import { z } from 'zod';

import type { Result } from '../result.ts';
import { ticketIdSchema } from '../ticket/ticket.ts';

export interface FactLineReason {
  message: string;
}

const baseShape = {
  version: z.literal(1),
  ticket: ticketIdSchema,
  at: z.iso.datetime(),
  machine: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Machine name must match ^[a-z0-9][a-z0-9._-]*$.'),
};

const claimSchema = z.strictObject({
  ...baseShape,
  kind: z.literal('claim'),
  holder: z.string().min(1),
  leaseEnd: z.iso.datetime(),
  session: z.string().optional(),
  sessionLog: z.string().optional(),
  forced: z.string().min(1).optional(),
});

const releaseSchema = z.strictObject({
  ...baseShape,
  kind: z.literal('release'),
  holder: z.string().min(1),
});

const logSchema = z.strictObject({
  ...baseShape,
  kind: z.literal('log'),
  type: z.enum(['progress', 'question', 'answer', 'discovered', 'submitted']),
  text: z.string(),
  holder: z.string().min(1).optional(),
  forced: z.string().min(1).optional(),
});

const acceptSchema = z.strictObject({
  ...baseShape,
  kind: z.literal('accept'),
  holder: z.string().min(1).optional(),
});

const statusSchema = z.strictObject({
  ...baseShape,
  kind: z.literal('status'),
  status: z.enum(['draft', 'open', 'canceled', 'closed']),
  forced: z.string().min(1).optional(),
});

const unarchiveSchema = z.strictObject({
  ...baseShape,
  kind: z.literal('unarchive'),
});

const factSchema = z.discriminatedUnion('kind', [
  claimSchema,
  releaseSchema,
  logSchema,
  acceptSchema,
  statusSchema,
  unarchiveSchema,
]);

export type Fact = z.output<typeof factSchema>;

const fail = (message: string): { ok: false; reason: FactLineReason } => ({
  ok: false,
  reason: { message },
});

export const validateFact = (value: unknown): Result<Fact, FactLineReason> => {
  const parsed = factSchema.safeParse(value);

  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }

  const issue = parsed.error.issues[0];
  const location = issue?.path.join('.') ?? '';
  const prefix = location === '' ? '' : `${location}: `;

  return fail(`${prefix}${issue?.message ?? 'Invalid fact line.'}`);
};

export const parseFactLine = (text: string): Result<Fact, FactLineReason> => {
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return fail(`The fact line is not valid JSON: ${detail}`);
  }

  return validateFact(json);
};

export const serializeFactLine = (fact: Fact): string => `${JSON.stringify(fact)}\n`;
