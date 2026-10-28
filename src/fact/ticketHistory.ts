import type { TicketId } from '../ticket/ticket.ts';
import type { Fact } from './factLine.ts';

const timeOf = (fact: Fact): number => Date.parse(fact.at);

export const selectTicketHistory = (facts: Fact[], id: TicketId): Fact[] =>
  facts
    .filter((fact) => fact.ticket === id)
    .toSorted((left, right) => timeOf(right) - timeOf(left));
