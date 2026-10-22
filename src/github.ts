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

export type RunGh = (args: string[], signal: AbortSignal) => Promise<Result<string, GithubReason>>;

interface GhCall {
  runGh: RunGh;
  signal: AbortSignal;
}

const ghTimeoutMilliseconds = 30_000;

// Bounds one pull request read, so a stalled gh cannot hang the command that waits for it.
export const ghSignal = (): AbortSignal => AbortSignal.timeout(ghTimeoutMilliseconds);

const pullRequestSchema = z.object({
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  baseRefName: z.string().min(1),
  headRefOid: z.string().min(1),
  mergeCommit: z.object({ oid: z.string().min(1) }).nullable(),
});

const repositorySchema = z.object({ defaultBranchRef: z.object({ name: z.string().min(1) }) });

const compareStatusSchema = z.enum(['ahead', 'behind', 'identical', 'diverged']);

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
  gh: GhCall,
  args: string[],
  parse: (text: string, command: string) => Result<Value, GithubReason>,
): Promise<Result<Value, GithubReason>> => {
  const output = await gh.runGh(args, gh.signal);

  if (!output.ok) {
    return output;
  }

  return parse(output.value, `gh ${args.join(' ')}`);
};

const isMergedInTrunk = async (
  gh: GhCall,
  ref: PullRequestRef,
  trunk: string,
  mergeCommit: string,
): Promise<Result<boolean, GithubReason>> => {
  const range = `${trunk}...${mergeCommit}`;

  const output = await gh.runGh(
    ['api', `repos/${ref.repository}/compare/${range}`, '--jq', '.status'],
    gh.signal,
  );

  if (!output.ok) {
    return output;
  }

  const status = compareStatusSchema.safeParse(output.value.trim());

  if (!status.success) {
    const command = `gh api repos/${ref.repository}/compare/${range}`;

    return { ok: false, reason: { message: `"${command}" gave unexpected output.` } };
  }

  return { ok: true, value: status.data === 'behind' || status.data === 'identical' };
};

const readInTrunk = async (
  gh: GhCall,
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

  return isMergedInTrunk(gh, ref, trunk, pullRequest.mergeCommit);
};

export const readPullRequest = async (
  runGh: RunGh,
  ref: PullRequestRef,
  signal: AbortSignal,
): Promise<Result<PullRequestObservation, GithubReason>> => {
  const gh = { runGh, signal };
  const fields = 'number,state,baseRefName,headRefOid,mergeCommit';
  const view = ['pr', 'view', String(ref.number), '--repo', ref.repository, '--json', fields];
  const pullRequest = await readView(gh, view, parsePullRequestView);

  if (!pullRequest.ok) {
    return pullRequest;
  }

  const repoView = ['repo', 'view', ref.repository, '--json', 'defaultBranchRef'];
  const trunk = await readView(gh, repoView, parseTrunkName);

  if (!trunk.ok) {
    return trunk;
  }

  const inTrunk = await readInTrunk(gh, ref, pullRequest.value, trunk.value);

  if (!inTrunk.ok) {
    return inTrunk;
  }

  return { ok: true, value: { ...pullRequest.value, trunk: trunk.value, inTrunk: inTrunk.value } };
};
