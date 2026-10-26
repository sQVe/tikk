import type { TicketFrontMatter, TicketId } from '../ticket/ticket.ts';
import type { Fact } from './factLine.ts';

export interface InstructionTicket {
  id: TicketId;
  frontMatter: TicketFrontMatter;
}

export type InstructionStateName = 'draft' | 'open' | 'active' | 'submitted' | 'done' | 'canceled';

export interface InstructionClaim {
  holder: string;
  leaseEnd: string;
  session: string | null;
  sessionLog: string | null;
}

interface StatusTicket {
  frontMatter: Pick<TicketFrontMatter, 'status'>;
}

export interface InstructionState {
  state: InstructionStateName;
  claim: InstructionClaim | null;
}

const lastIndexWhere = (facts: Fact[], matches: (fact: Fact) => boolean): number => {
  for (let index = facts.length - 1; index >= 0; index -= 1) {
    const fact = facts[index];

    if (fact !== undefined && matches(fact)) {
      return index;
    }
  }

  return -1;
};

const stateOnly = (state: InstructionStateName): InstructionState => ({ state, claim: null });

export const deriveInstructionStateFromOwnFacts = (
  ticket: StatusTicket,
  own: Fact[],
  now: Date,
): InstructionState => {
  const { status } = ticket.frontMatter;

  if (status === 'canceled' || status === 'draft') {
    return stateOnly(status);
  }

  if (own.some((fact) => fact.kind === 'accept')) {
    return stateOnly('done');
  }

  const claimIndex = lastIndexWhere(own, (fact) => fact.kind === 'claim');

  const submittedIndex = lastIndexWhere(
    own,
    (fact) => fact.kind === 'log' && fact.type === 'submitted',
  );

  if (submittedIndex > claimIndex) {
    return stateOnly('submitted');
  }

  const holderIndex = lastIndexWhere(
    own,
    (fact) => fact.kind === 'claim' || fact.kind === 'release',
  );

  const holderFact = own[holderIndex];

  if (holderFact?.kind === 'claim' && new Date(holderFact.leaseEnd) > now) {
    return {
      state: 'active',
      claim: {
        holder: holderFact.holder,
        leaseEnd: holderFact.leaseEnd,
        session: holderFact.session ?? null,
        sessionLog: holderFact.sessionLog ?? null,
      },
    };
  }

  return stateOnly('open');
};

export const deriveInstructionState = (
  ticket: InstructionTicket,
  facts: Fact[],
  now: Date,
): InstructionState =>
  deriveInstructionStateFromOwnFacts(
    ticket,
    facts.filter((fact) => fact.ticket === ticket.id),
    now,
  );
