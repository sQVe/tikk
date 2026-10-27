import type { TicketId } from '../ticket/ticket.ts';
import { ageSecondsOf } from './ageSeconds.ts';
import type { Fact } from './factLine.ts';
import type { InstructionTicket } from './instructionState.ts';
import type { NeedItem } from './needsQuery.ts';
import type { deriveStates } from './ticketStates.ts';
import { blockerState, clearingStates } from './ticketStates.ts';

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
    return [{ ticket: task, reason: 'blockingTask', ...dated, blocks }];
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
      since: waiting.at,
      ageSeconds: ageSecondsOf(waiting.at, now),
      ...(waiting.text === undefined ? {} : { text: waiting.text }),
    },
  ];
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

export const selectTaskNeeds = <Ticket extends InstructionTicket>(
  tickets: Ticket[],
  factsByTicket: Map<TicketId, Fact[]>,
  states: ReturnType<typeof deriveStates>,
  now: Date,
): NeedItem<Ticket>[] =>
  tickets
    .filter(isOpenTask)
    .flatMap((task) =>
      taskNeedsOf(task, blocksOf(task, tickets, states), factsByTicket.get(task.id) ?? [], now),
    );

export const selectDraftPlanNeeds = <Ticket extends InstructionTicket>(
  tickets: Ticket[],
  factsByTicket: Map<TicketId, Fact[]>,
  now: Date,
): NeedItem<Ticket>[] =>
  tickets
    .filter(isDraftPlan)
    .flatMap((plan) => draftPlanNeedsOf(plan, factsByTicket.get(plan.id) ?? [], now));
