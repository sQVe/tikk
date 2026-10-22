import { z } from 'zod';

import type { Result } from './result.ts';

export interface PullRequestView {
  state: 'open' | 'closed' | 'merged';
  base: string;
  head: string;
  mergeCommit: string | null;
}

interface GithubReason {
  message: string;
}

const pullRequestSchema = z.object({
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  baseRefName: z.string().min(1),
  headRefOid: z.string().min(1),
  mergeCommit: z.object({ oid: z.string().min(1) }).nullable(),
});

const repositorySchema = z.object({ defaultBranchRef: z.object({ name: z.string().min(1) }) });

const states = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' } as const;

const parseOutput = <Schema extends z.ZodType>(
  schema: Schema,
  text: string,
  command: string,
): Result<z.output<Schema>, GithubReason> => {
  try {
    const parsed = schema.safeParse(JSON.parse(text));

    if (parsed.success) {
      return { ok: true, value: parsed.data };
    }

    return { ok: false, reason: { message: `"${command}" gave unexpected output.` } };
  } catch {
    return { ok: false, reason: { message: `"${command}" gave output that is not JSON.` } };
  }
};

export const parsePullRequestView = (
  text: string,
  command: string,
): Result<PullRequestView, GithubReason> => {
  const parsed = parseOutput(pullRequestSchema, text, command);

  if (!parsed.ok) {
    return parsed;
  }

  const { state, baseRefName, headRefOid, mergeCommit } = parsed.value;

  return {
    ok: true,
    value: {
      state: states[state],
      base: baseRefName,
      head: headRefOid,
      mergeCommit: mergeCommit?.oid ?? null,
    },
  };
};

export const parseTrunkName = (text: string, command: string): Result<string, GithubReason> => {
  const parsed = parseOutput(repositorySchema, text, command);

  if (!parsed.ok) {
    return parsed;
  }

  return { ok: true, value: parsed.value.defaultBranchRef.name };
};
