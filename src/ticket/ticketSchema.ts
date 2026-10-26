import { z } from 'zod';

import { projectNameSchema, ticketIdSchema } from './ticketId.ts';

interface NewCandidate {
  kind: string;
  status: string;
  parent?: string | undefined;
}

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

export const isLooseOpenTask = (frontMatter: NewCandidate): boolean =>
  frontMatter.kind === 'task' && frontMatter.status === 'open' && frontMatter.parent === undefined;

export const ticketFrontMatterSchema = z
  .strictObject({
    kind: z.enum(['plan', 'slice', 'task', 'instruction']),
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
    status: z.enum(['draft', 'open', 'canceled', 'done']),
    new: z.boolean().optional(),
    archived: z.iso.date().optional(),
  })
  .refine((frontMatter) => frontMatter.kind === 'task' || frontMatter.status !== 'done', {
    message: 'Status "done" is only valid for a task.',
    path: ['status'],
  })
  .refine((frontMatter) => frontMatter.kind !== 'task' || frontMatter.status !== 'draft', {
    message: 'A task cannot be a draft.',
    path: ['status'],
  })
  .refine((frontMatter) => frontMatter.new === undefined || isLooseOpenTask(frontMatter), {
    message: 'New is only valid on an open task with no parent.',
    path: ['new'],
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
      frontMatter.kind === 'instruction',
    { message: 'Covers is only valid for a slice or an instruction.', path: ['covers'] },
  );

export type TicketFrontMatter = z.output<typeof ticketFrontMatterSchema>;

export const withoutNew = (frontMatter: TicketFrontMatter): TicketFrontMatter => {
  const copy = { ...frontMatter };

  delete copy.new;

  return copy;
};
