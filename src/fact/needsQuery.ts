import type { Fact } from './factLine.ts';
import { deriveTaskStateFromOwnFacts } from './taskState.ts';
import type { TaskTicket } from './taskState.ts';

type NeedReason = 'question' | 'submitted' | 'staleClaim';

export interface NeedItem<Ticket extends TaskTicket> {
  ticket: Ticket;
  reason: NeedReason;
  since: string;
  ageSeconds: number;
  holder?: string;
}

const notWaiting = new Set<string>(['draft', 'done', 'canceled']);

const millisecondsPerSecond = 1000;

const ageSecondsOf = (since: string, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / millisecondsPerSecond));

const oldestOpenQuestion = (own: Fact[]): string | undefined => {
  let oldest: string | undefined;

  for (const fact of own) {
    if (fact.kind !== 'log') {
      continue;
    }

    if (fact.type === 'answer') {
      oldest = undefined;
    }

    if (fact.type === 'question') {
      oldest ??= fact.at;
    }
  }

  return oldest;
};

const submittedSince = (own: Fact[]): string | undefined =>
  own.findLast((fact) => fact.kind === 'log' && fact.type === 'submitted')?.at;

const staleClaimOf = (own: Fact[], now: Date): { holder: string; since: string } | undefined => {
  const holderFact = own.findLast((fact) => fact.kind === 'claim' || fact.kind === 'release');

  if (holderFact?.kind !== 'claim' || new Date(holderFact.leaseEnd) > now) {
    return undefined;
  }

  return { holder: holderFact.holder, since: holderFact.leaseEnd };
};

const needsOf = <Ticket extends TaskTicket>(
  ticket: Ticket,
  own: Fact[],
  now: Date,
): NeedItem<Ticket>[] => {
  const { state } = deriveTaskStateFromOwnFacts(ticket, own, now);

  if (notWaiting.has(state)) {
    return [];
  }

  const items: NeedItem<Ticket>[] = [];
  const questionSince = oldestOpenQuestion(own);

  if (questionSince !== undefined) {
    items.push({
      ticket,
      reason: 'question',
      since: questionSince,
      ageSeconds: ageSecondsOf(questionSince, now),
    });
  }

  const submitted = state === 'submitted' ? submittedSince(own) : undefined;

  if (submitted !== undefined) {
    items.push({
      ticket,
      reason: 'submitted',
      since: submitted,
      ageSeconds: ageSecondsOf(submitted, now),
    });
  }

  const stale = state === 'open' ? staleClaimOf(own, now) : undefined;

  if (stale !== undefined) {
    items.push({
      ticket,
      reason: 'staleClaim',
      since: stale.since,
      ageSeconds: ageSecondsOf(stale.since, now),
      holder: stale.holder,
    });
  }

  return items;
};

const isConsidered = (ticket: TaskTicket): boolean => {
  const { frontMatter } = ticket;

  return frontMatter.kind === 'task' && frontMatter.archived === undefined;
};

const byOldest = <Ticket extends TaskTicket>(a: NeedItem<Ticket>, b: NeedItem<Ticket>): number => {
  const bySince = new Date(a.since).getTime() - new Date(b.since).getTime();

  if (bySince !== 0) {
    return bySince;
  }

  return a.ticket.id.localeCompare(b.ticket.id);
};

export const selectNeeds = <Ticket extends TaskTicket>(
  tickets: Ticket[],
  facts: Fact[],
  now: Date,
): NeedItem<Ticket>[] => {
  const factsByTicket = Map.groupBy(facts, (fact) => fact.ticket);

  return tickets
    .filter(isConsidered)
    .flatMap((ticket) => needsOf(ticket, factsByTicket.get(ticket.id) ?? [], now))
    .toSorted(byOldest);
};
