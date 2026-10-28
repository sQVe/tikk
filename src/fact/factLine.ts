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

const itemIdSchema = z
  .string()
  .regex(/^[0-9a-f]{12}$/, 'Item must be 12 lower-case hex characters.');

const logShape = {
  ...baseShape,
  kind: z.literal('log'),
  text: z.string(),
  holder: z.string().min(1).optional(),
  forced: z.string().min(1).optional(),
};

const logSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...logShape, type: z.enum(['progress', 'discovered']) }),
  z.strictObject({
    ...logShape,
    type: z.enum(['question', 'answer', 'submitted']),
    item: itemIdSchema,
  }),
]);

const acceptSchema = z.strictObject({
  ...baseShape,
  kind: z.literal('accept'),
  item: itemIdSchema,
  holder: z.string().min(1).optional(),
});

const passUpSchema = z.strictObject({
  ...baseShape,
  kind: z.literal('passUp'),
  item: itemIdSchema,
});

const rejectSchema = z.strictObject({
  ...baseShape,
  kind: z.literal('reject'),
  item: itemIdSchema,
  reason: z.string().min(1),
  holder: z.string().min(1).optional(),
});

const statusSchema = z.strictObject({
  ...baseShape,
  kind: z.literal('status'),
  status: z.enum(['draft', 'open', 'canceled', 'done']),
  forced: z.string().min(1).optional(),
});

const waitingSchema = z.strictObject({
  ...baseShape,
  kind: z.literal('waiting'),
  waiting: z.boolean(),
  text: z.string().min(1).optional(),
});

const unarchiveSchema = z.strictObject({
  ...baseShape,
  kind: z.literal('unarchive'),
});

const movedFactSchema = z.strictObject({
  path: z.string().min(1),
  line: z.number().int().positive(),
});

const aliasSchema = z.strictObject({
  ...baseShape,
  kind: z.literal('alias'),
  from: ticketIdSchema,
  movedFacts: z.array(movedFactSchema).optional(),
});

const repositorySchema = z
  .string()
  .regex(/^[^/\s]+\/[^/\s]+$/, 'Repository must look like owner/name.');

const prSchema = z.strictObject({
  ...baseShape,
  kind: z.literal('pr'),
  repository: repositorySchema,
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed', 'merged']),
  base: z.string().min(1),
  head: z.string().min(1),
  mergeCommit: z.string().min(1).optional(),
  trunk: z.string().min(1),
  inTrunk: z.boolean(),
});

const auditVerdictSchema = z.strictObject({
  criterion: z.string().min(1),
  verdict: z.enum(['met', 'not-met', 'not-run', 'deferred']),
  evidence: z.string().min(1),
  qa: z.array(z.string().min(1)).min(1).optional(),
  definition: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

const auditSchema = z.strictObject({
  ...baseShape,
  kind: z.literal('audit'),
  repository: repositorySchema,
  changeHash: z.string().min(1),
  head: z.string().min(1),
  base: z.string().min(1),
  verdicts: z.array(auditVerdictSchema).min(1),
});

const nonEmpty = z.string().min(1);

const targetSchema = z.strictObject({
  repository: nonEmpty,
  head: nonEmpty,
  base: nonEmpty,
  changeHash: nonEmpty,
});

const checkSchema = z.strictObject({
  ...baseShape,
  kind: z.literal('check'),
  target: targetSchema,
  command: nonEmpty,
  exitCode: z.number().int(),
  log: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'Log must be a SHA-256 hash in lower-case hex.')
    .optional(),
});

const qaScenarioSchema = z.strictObject({
  name: nonEmpty,
  criteria: z.array(nonEmpty).min(1),
  observed: nonEmpty,
  verdict: z.enum(['pass', 'fail', 'blocked']),
});

const qaSchema = z.strictObject({
  ...baseShape,
  kind: z.literal('qa'),
  // An audit names its repository as owner/name and cites only runs of the same repository.
  target: targetSchema.extend({ repository: repositorySchema }),
  run: z.string().regex(/^[0-9a-f]{12}$/, 'Run must be 12 lower-case hex characters.'),
  scenarios: z.array(qaScenarioSchema).min(1),
  artifacts: z.array(z.string()),
  gaps: z.array(z.string()),
});

export const reviewFindingSchema = z.strictObject({
  fingerprint: nonEmpty,
  severity: z.enum(['high', 'medium', 'low']),
  location: nonEmpty,
  claim: nonEmpty,
});

const reviewSchema = z.strictObject({
  ...baseShape,
  kind: z.literal('review'),
  target: targetSchema,
  captureHash: nonEmpty,
  mode: nonEmpty,
  findings: z
    .array(reviewFindingSchema)
    .refine(
      (findings) =>
        new Set(findings.map((finding) => finding.fingerprint)).size === findings.length,
      'Finding fingerprints must be unique within one review.',
    ),
});

const findingSchema = z.strictObject({
  ...baseShape,
  kind: z.literal('finding'),
  fingerprint: nonEmpty,
  status: z.enum(['open', 'fixed', 'notWorthChanging', 'incorrect', 'blocked']),
  actor: nonEmpty,
  reason: nonEmpty,
});

const factSchema = z.discriminatedUnion('kind', [
  claimSchema,
  releaseSchema,
  logSchema,
  acceptSchema,
  passUpSchema,
  rejectSchema,
  statusSchema,
  waitingSchema,
  unarchiveSchema,
  aliasSchema,
  prSchema,
  auditSchema,
  checkSchema,
  qaSchema,
  reviewSchema,
  findingSchema,
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
