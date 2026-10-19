import { z } from 'zod';

import { projectNameSchema, ticketIdSchema } from './ticketId.ts';

export const ticketFrontMatterSchema = z
  .strictObject({
    kind: z.enum(['task', 'issue']),
    title: z.string().min(1),
    project: projectNameSchema,
    parent: ticketIdSchema.optional(),
    rank: z.number().optional(),
    blockedBy: z.array(ticketIdSchema).default([]),
    status: z.enum(['draft', 'open', 'canceled', 'closed']),
    archived: z.iso.date().optional(),
  })
  .refine((frontMatter) => frontMatter.kind === 'issue' || frontMatter.status !== 'closed', {
    message: 'Status "closed" is only valid for an issue.',
    path: ['status'],
  });

export type TicketFrontMatter = z.output<typeof ticketFrontMatterSchema>;
