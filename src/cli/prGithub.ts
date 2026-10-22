import type { Fact } from '../fact/fact.ts';
import { parsePullRequestView, parseTrunkName } from '../github.ts';
import type { PullRequestView } from '../github.ts';
import type { Result } from '../result.ts';
import type { TicketId } from '../ticket/ticket.ts';
import type { CliEffects } from './cliEffects.ts';

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

interface GhReason {
  message: string;
}

type PrFact = Extract<Fact, { kind: 'pr' }>;

const readView = async <Value>(
  runGh: CliEffects['runGh'],
  args: string[],
  parse: (text: string, command: string) => Result<Value, GhReason>,
): Promise<Result<Value, GhReason>> => {
  const output = await runGh(args);

  if (!output.ok) {
    return output;
  }

  return parse(output.value, `gh ${args.join(' ')}`);
};

const isMergedInTrunk = async (
  runGh: CliEffects['runGh'],
  ref: PullRequestRef,
  trunk: string,
  mergeCommit: string,
): Promise<Result<boolean, GhReason>> => {
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
  runGh: CliEffects['runGh'],
  ref: PullRequestRef,
  pullRequest: PullRequestView,
  trunk: string,
): Promise<Result<boolean, GhReason>> => {
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
  runGh: CliEffects['runGh'],
  ref: PullRequestRef,
): Promise<Result<PullRequestObservation, GhReason>> => {
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

export const differsFromObservation = (
  known: {
    state: string;
    base: string;
    head: string;
    mergeCommit: string | null;
    inTrunk: boolean;
  },
  seen: PullRequestObservation,
): boolean => {
  const sameState = known.state === seen.state && known.inTrunk === seen.inTrunk;
  const sameRefs = known.base === seen.base && known.head === seen.head;

  return !(sameState && sameRefs && known.mergeCommit === seen.mergeCommit);
};

export const makePrFact = (
  base: { ticket: TicketId; at: Date; machine: string },
  ref: PullRequestRef,
  seen: PullRequestObservation,
): PrFact => ({
  version: 1,
  kind: 'pr',
  ticket: base.ticket,
  at: base.at.toISOString(),
  machine: base.machine,
  repository: ref.repository,
  number: ref.number,
  state: seen.state,
  base: seen.base,
  head: seen.head,
  ...(seen.mergeCommit === null ? {} : { mergeCommit: seen.mergeCommit }),
  trunk: seen.trunk,
  inTrunk: seen.inTrunk,
});
