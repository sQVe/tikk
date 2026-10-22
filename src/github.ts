import { z } from 'zod';

import type { Result } from './result.ts';

interface PullRequestView {
  state: 'open' | 'closed' | 'merged';
  base: string;
  head: string;
  mergeCommit: string | null;
}

export interface GithubReason {
  message: string;
}

export interface PullRequestRef {
  repository: string;
  number: number;
}

export interface PullRequestObservation {
  state: 'open' | 'closed' | 'merged';
  base: string;
  head: string;
  mergeCommit: string | null;
  trunk: string;
  inTrunk: boolean;
}

export type RunGh = (args: string[]) => Promise<Result<string, GithubReason>>;

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

const parsePullRequestView = (
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

const parseTrunkName = (text: string, command: string): Result<string, GithubReason> => {
  const parsed = parseOutput(repositorySchema, text, command);

  if (!parsed.ok) {
    return parsed;
  }

  return { ok: true, value: parsed.value.defaultBranchRef.name };
};

const readView = async <Value>(
  runGh: RunGh,
  args: string[],
  parse: (text: string, command: string) => Result<Value, GithubReason>,
): Promise<Result<Value, GithubReason>> => {
  const output = await runGh(args);

  if (!output.ok) {
    return output;
  }

  return parse(output.value, `gh ${args.join(' ')}`);
};

const isMergedInTrunk = async (
  runGh: RunGh,
  ref: PullRequestRef,
  trunk: string,
  mergeCommit: string,
): Promise<Result<boolean, GithubReason>> => {
  const range = `${trunk}...${mergeCommit}`;

  const output = await runGh([
    'api',
    `repos/${ref.repository}/compare/${range}`,
    '--jq',
    '.status',
  ]);

  if (!output.ok) {
    return output;
  }

  const status = output.value.trim();

  return { ok: true, value: status === 'behind' || status === 'identical' };
};

const readInTrunk = async (
  runGh: RunGh,
  ref: PullRequestRef,
  pullRequest: PullRequestView,
  trunk: string,
): Promise<Result<boolean, GithubReason>> => {
  if (pullRequest.state !== 'merged') {
    return { ok: true, value: false };
  }

  if (pullRequest.base === trunk) {
    return { ok: true, value: true };
  }

  if (pullRequest.mergeCommit === null) {
    return { ok: true, value: false };
  }

  return isMergedInTrunk(runGh, ref, trunk, pullRequest.mergeCommit);
};

export const readPullRequest = async (
  runGh: RunGh,
  ref: PullRequestRef,
): Promise<Result<PullRequestObservation, GithubReason>> => {
  const fields = 'number,state,baseRefName,headRefOid,mergeCommit';
  const view = ['pr', 'view', String(ref.number), '--repo', ref.repository, '--json', fields];
  const pullRequest = await readView(runGh, view, parsePullRequestView);

  if (!pullRequest.ok) {
    return pullRequest;
  }

  const repoView = ['repo', 'view', ref.repository, '--json', 'defaultBranchRef'];
  const trunk = await readView(runGh, repoView, parseTrunkName);

  if (!trunk.ok) {
    return trunk;
  }

  const inTrunk = await readInTrunk(runGh, ref, pullRequest.value, trunk.value);

  if (!inTrunk.ok) {
    return inTrunk;
  }

  return { ok: true, value: { ...pullRequest.value, trunk: trunk.value, inTrunk: inTrunk.value } };
};
