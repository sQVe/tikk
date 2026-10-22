import { z } from 'zod';

import type { Result } from '../result.ts';
import { reviewFindingSchema } from './factLine.ts';

export type ReviewFinding = z.output<typeof reviewFindingSchema>;

const findingsSchema = z.array(reviewFindingSchema);

export const parseReviewFindings = (text: string): Result<ReviewFinding[], { message: string }> => {
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: { message: 'The text is not valid JSON.' } };
  }

  const parsed = findingsSchema.safeParse(json);

  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }

  const issue = parsed.error.issues[0];
  const location = issue?.path.join('.') ?? '';
  const prefix = location === '' ? '' : `${location}: `;

  return { ok: false, reason: { message: `${prefix}${issue?.message ?? 'Invalid findings.'}` } };
};
