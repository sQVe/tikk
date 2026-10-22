import { z } from 'zod';

import { projectNameSchema, ticketIdSchema } from './ticketId.ts';

const criterionIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, {
  message: 'A criterion ID must be lowercase letters, digits, and hyphens.',
});

const criterionSchema = z.strictObject({
  id: criterionIdSchema,
  check: z.string().min(1),
  expected: z.string().min(1),
});

const hasUniqueIds = (criteria: { id: string }[]): boolean =>
  new Set(criteria.map((criterion) => criterion.id)).size === criteria.length;

export const ticketFrontMatterSchema = z
  .strictObject({
    kind: z.enum(['plan', 'slice', 'task', 'issue']),
    title: z.string().min(1),
    project: projectNameSchema,
    parent: ticketIdSchema.optional(),
    rank: z.number().optional(),
    blockedBy: z.array(ticketIdSchema).default([]),
    discoveredFrom: z.array(ticketIdSchema).default([]),
    related: z.array(ticketIdSchema).default([]),
    criteria: z
      .array(criterionSchema)
      .refine(hasUniqueIds, { message: 'Criterion IDs must be unique in a ticket.' })
      .optional(),
    covers: z.array(criterionIdSchema).optional(),
    status: z.enum(['draft', 'open', 'canceled', 'closed']),
    archived: z.iso.date().optional(),
  })
  .refine((frontMatter) => frontMatter.kind === 'issue' || frontMatter.status !== 'closed', {
    message: 'Status "closed" is only valid for an issue.',
    path: ['status'],
  })
  .refine(
    (frontMatter) =>
      frontMatter.criteria === undefined ||
      frontMatter.kind === 'plan' ||
      frontMatter.kind === 'slice',
    { message: 'Criteria are only valid for a plan or a slice.', path: ['criteria'] },
  )
  .refine(
    (frontMatter) => {
      const isPlanOrSlice = frontMatter.kind === 'plan' || frontMatter.kind === 'slice';
      const needsCriteria = isPlanOrSlice && frontMatter.status === 'open';

      return !needsCriteria || (frontMatter.criteria ?? []).length > 0;
    },
    {
      message:
        'An open plan or slice needs at least one criterion. Pass --criteria-file or --status draft.',
      path: ['criteria'],
    },
  )
  .refine(
    (frontMatter) =>
      frontMatter.covers === undefined ||
      frontMatter.kind === 'slice' ||
      frontMatter.kind === 'task',
    { message: 'Covers is only valid for a slice or a task.', path: ['covers'] },
  );

export type TicketFrontMatter = z.output<typeof ticketFrontMatterSchema>;
