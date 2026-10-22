import type { Fact } from '../fact/fact.ts';
import type { PullRequestObservation, PullRequestRef } from '../github.ts';
import type { TicketId } from '../ticket/ticket.ts';

type PrFact = Extract<Fact, { kind: 'pr' }>;

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
