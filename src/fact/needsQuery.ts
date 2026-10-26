import type { TicketId } from '../ticket/ticket.ts';
import type { Fact } from './factLine.ts';
import { selectFindings } from './findingStatus.ts';
import { deriveInstructionStateFromOwnFacts } from './instructionState.ts';
import type { InstructionTicket } from './instructionState.ts';
import { buildSliceIndex, deriveSliceState } from './sliceState.ts';
import type { SliceIndex } from './sliceState.ts';

interface NeedBase<Ticket extends InstructionTicket> {
  ticket: Ticket;
  since: string;
  ageSeconds: number;
}

type NeedDetail =
  | { reason: 'question' | 'submitted' | 'mergedUnverified' }
  | { reason: 'flagged'; openInstructions: TicketId[]; openTasks: TicketId[] }
  | { reason: 'staleClaim'; holder: string }
  | { reason: 'blockedFinding'; fingerprint: string; claim: string };

export type NeedItem<Ticket extends InstructionTicket> = NeedBase<Ticket> & NeedDetail;

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

const needsOf = <Ticket extends InstructionTicket>(
  ticket: Ticket,
  own: Fact[],
  now: Date,
): NeedItem<Ticket>[] => {
  const { state } = deriveInstructionStateFromOwnFacts(ticket, own, now);

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

const blockedFindingsOf = <Ticket extends InstructionTicket>(
  ticket: Ticket,
  own: Fact[],
  now: Date,
): NeedItem<Ticket>[] =>
  selectFindings(own, ticket.id)
    .filter((finding) => finding.status === 'blocked')
    .flatMap((finding) => {
      const statusFact = own.findLast(
        (fact) => fact.kind === 'finding' && fact.fingerprint === finding.fingerprint,
      );

      if (statusFact === undefined) {
        return [];
      }

      return [
        {
          ticket,
          reason: 'blockedFinding' as const,
          since: statusFact.at,
          ageSeconds: ageSecondsOf(statusFact.at, now),
          fingerprint: finding.fingerprint,
          claim: finding.claim,
        },
      ];
    });

const isConsidered = (ticket: InstructionTicket): boolean => {
  const { frontMatter } = ticket;

  return frontMatter.kind === 'instruction' && frontMatter.archived === undefined;
};

const isOpenSlice = (ticket: InstructionTicket): boolean => {
  const { frontMatter } = ticket;

  return (
    frontMatter.kind === 'slice' &&
    frontMatter.status === 'open' &&
    frontMatter.archived === undefined
  );
};

const sliceNeedsOf = <Ticket extends InstructionTicket>(
  slice: Ticket,
  index: SliceIndex,
  now: Date,
): NeedItem<Ticket>[] => {
  const derived = deriveSliceState(slice, index, now);
  const since = derived.pr?.checkedAt;
  const items: NeedItem<Ticket>[] = [];

  if (since === undefined) {
    return items;
  }

  const ageSeconds = ageSecondsOf(since, now);

  if (derived.state === 'mergedUnverified') {
    items.push({ ticket: slice, reason: 'mergedUnverified', since, ageSeconds });
  }

  const { openInstructions, openTasks } = derived;
  const hasOpenWork = openInstructions.length > 0 || openTasks.length > 0;

  if (hasOpenWork) {
    items.push({
      ticket: slice,
      reason: 'flagged',
      since,
      ageSeconds,
      openInstructions,
      openTasks,
    });
  }

  return items;
};

const byOldest = <Ticket extends InstructionTicket>(
  a: NeedItem<Ticket>,
  b: NeedItem<Ticket>,
): number => {
  const bySince = new Date(a.since).getTime() - new Date(b.since).getTime();

  if (bySince !== 0) {
    return bySince;
  }

  return a.ticket.id.localeCompare(b.ticket.id);
};

export const selectNeeds = <Ticket extends InstructionTicket>(
  tickets: Ticket[],
  facts: Fact[],
  now: Date,
): NeedItem<Ticket>[] => {
  const index = buildSliceIndex(tickets, facts);
  const { factsByTicket } = index;

  const instructionItems = tickets
    .filter(isConsidered)
    .flatMap((ticket) => needsOf(ticket, factsByTicket.get(ticket.id) ?? [], now));

  const sliceItems = tickets
    .filter(isOpenSlice)
    .flatMap((slice) => sliceNeedsOf(slice, index, now));

  const findingItems = tickets
    .filter((ticket) => ticket.frontMatter.archived === undefined)
    .flatMap((ticket) => blockedFindingsOf(ticket, factsByTicket.get(ticket.id) ?? [], now));

  return [...instructionItems, ...sliceItems, ...findingItems].toSorted(byOldest);
};
