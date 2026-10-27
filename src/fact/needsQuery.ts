import type { TicketId } from '../ticket/ticket.ts';
import type { Fact } from './factLine.ts';
import { selectFindings } from './findingStatus.ts';
import { latestSubmission, selectOpenQuestions, selectPassedUp } from './instructionItems.ts';
import { deriveInstructionStateFromOwnFacts, selectLastClaim } from './instructionState.ts';
import type { InstructionTicket } from './instructionState.ts';
import { buildSliceIndex, deriveSliceState } from './sliceState.ts';
import type { SliceIndex } from './sliceState.ts';
import { blockerState, clearingStates, deriveStates } from './ticketStates.ts';

// A task has no create time, so its since and age are null until it has a status fact.
interface NeedBase<Ticket extends InstructionTicket> {
  ticket: Ticket;
  since: string | null;
  ageSeconds: number | null;
}

type NeedDetail =
  | { reason: 'question' | 'submitted'; item: string; passedUp: boolean }
  | { reason: 'mergedUnverified' }
  | { reason: 'flagged'; openInstructions: TicketId[]; openTasks: TicketId[] }
  | { reason: 'staleClaim'; holder: string }
  | { reason: 'blockedFinding'; fingerprint: string; claim: string }
  | { reason: 'blockingTask'; blocks: TicketId[] }
  | { reason: 'newTask' }
  | { reason: 'draftPlan'; text?: string };

export type NeedItem<Ticket extends InstructionTicket> = NeedBase<Ticket> & NeedDetail;

const notWaiting = new Set<string>(['draft', 'done', 'canceled']);

const millisecondsPerSecond = 1000;

const ageSecondsOf = (since: string, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / millisecondsPerSecond));

// A question that nobody passed up still reaches the user after 30 minutes.
const questionTimeoutSeconds = 1800;

const questionNeedsOf = <Ticket extends InstructionTicket>(
  ticket: Ticket,
  own: Fact[],
  now: Date,
): NeedItem<Ticket>[] => {
  const passedUp = selectPassedUp(own);

  return selectOpenQuestions(own).flatMap(({ item, at }) => {
    const ageSeconds = ageSecondsOf(at, now);
    const isPassedUp = passedUp.has(item);

    if (!isPassedUp && ageSeconds < questionTimeoutSeconds) {
      return [];
    }

    return [
      {
        ticket,
        reason: 'question' as const,
        since: at,
        ageSeconds,
        item,
        passedUp: isPassedUp,
      },
    ];
  });
};

const submissionNeedsOf = <Ticket extends InstructionTicket>(
  ticket: Ticket,
  own: Fact[],
  now: Date,
): NeedItem<Ticket>[] => {
  const submission = latestSubmission(own);

  if (submission === undefined || !selectPassedUp(own).has(submission.item)) {
    return [];
  }

  const { item, at } = submission;

  return [
    {
      ticket,
      reason: 'submitted',
      since: at,
      ageSeconds: ageSecondsOf(at, now),
      item,
      passedUp: true,
    },
  ];
};

const staleClaimOf = (own: Fact[], now: Date): { holder: string; since: string } | undefined => {
  const holderFact = selectLastClaim(own);

  if (holderFact === undefined || new Date(holderFact.leaseEnd) > now) {
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

  const items = questionNeedsOf(ticket, own, now);

  if (state === 'submitted') {
    items.push(...submissionNeedsOf(ticket, own, now));
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

// A ticket's finished state comes from its facts, so an accepted instruction is finished.
const isUnfinished = (
  ticket: InstructionTicket,
  states: ReturnType<typeof deriveStates>,
): boolean =>
  ticket.frontMatter.archived === undefined && !clearingStates.has(blockerState(ticket, states));

const blocksOf = <Ticket extends InstructionTicket>(
  task: Ticket,
  tickets: Ticket[],
  states: ReturnType<typeof deriveStates>,
): TicketId[] =>
  tickets
    .filter(
      (ticket) => isUnfinished(ticket, states) && ticket.frontMatter.blockedBy.includes(task.id),
    )
    .map((ticket) => ticket.id)
    .toSorted((a, b) => a.localeCompare(b));

const datedBy = (
  at: string | undefined,
  now: Date,
): { since: string | null; ageSeconds: number | null } =>
  at === undefined
    ? { since: null, ageSeconds: null }
    : { since: at, ageSeconds: ageSecondsOf(at, now) };

const taskNeedsOf = <Ticket extends InstructionTicket>(
  task: Ticket,
  blocks: TicketId[],
  own: Fact[],
  now: Date,
): NeedItem<Ticket>[] => {
  const dated = datedBy(own.findLast((fact) => fact.kind === 'status')?.at, now);

  if (blocks.length > 0) {
    return [{ ticket: task, reason: 'blockingTask', blocks, ...dated }];
  }

  if (task.frontMatter.new === true) {
    return [{ ticket: task, reason: 'newTask', ...dated }];
  }

  return [];
};

const draftPlanNeedsOf = <Ticket extends InstructionTicket>(
  plan: Ticket,
  own: Fact[],
  now: Date,
): NeedItem<Ticket>[] => {
  const waiting = own.findLast((fact) => fact.kind === 'waiting');

  if (waiting?.kind !== 'waiting' || !waiting.waiting) {
    return [];
  }

  return [
    {
      ticket: plan,
      reason: 'draftPlan',
      ...(waiting.text === undefined ? {} : { text: waiting.text }),
      since: waiting.at,
      ageSeconds: ageSecondsOf(waiting.at, now),
    },
  ];
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

const isOpenTask = (ticket: InstructionTicket): boolean => {
  const { frontMatter } = ticket;

  return (
    frontMatter.kind === 'task' &&
    frontMatter.status === 'open' &&
    frontMatter.archived === undefined
  );
};

const isDraftPlan = (ticket: InstructionTicket): boolean => {
  const { frontMatter } = ticket;

  return (
    frontMatter.kind === 'plan' &&
    frontMatter.status === 'draft' &&
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
    items.push({
      ticket: slice,
      reason: 'mergedUnverified',
      since,
      ageSeconds,
    });
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

// Items with no date sort after the dated items.
const compareSince = (a: string | null, b: string | null): number => {
  if (a === null || b === null) {
    return Number(a === null) - Number(b === null);
  }

  return new Date(a).getTime() - new Date(b).getTime();
};

const byOldest = <Ticket extends InstructionTicket>(
  a: NeedItem<Ticket>,
  b: NeedItem<Ticket>,
): number => {
  const bySince = compareSince(a.since, b.since);

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

  const states = deriveStates(tickets, index, now);

  const taskItems = tickets
    .filter(isOpenTask)
    .flatMap((task) =>
      taskNeedsOf(task, blocksOf(task, tickets, states), factsByTicket.get(task.id) ?? [], now),
    );

  const planItems = tickets
    .filter(isDraftPlan)
    .flatMap((plan) => draftPlanNeedsOf(plan, factsByTicket.get(plan.id) ?? [], now));

  return [...instructionItems, ...sliceItems, ...findingItems, ...taskItems, ...planItems].toSorted(
    byOldest,
  );
};
