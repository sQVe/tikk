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

export interface InstructionRejection {
  item: string;
  reason: string;
  at: string;
}

export interface InstructionState {
  state: InstructionStateName;
  claim: InstructionClaim | null;
  rejection: InstructionRejection | null;
}

type ClaimFact = Extract<Fact, { kind: 'claim' }>;

type DecisionFact = Extract<Fact, { kind: 'reject' | 'accept' }>;

type SubmittedFact = Extract<Fact, { kind: 'log'; item: string }> & { type: 'submitted' };

const isSubmittedLog = (fact: Fact): fact is SubmittedFact =>
  fact.kind === 'log' && fact.type === 'submitted';

const lastIndexWhere = (facts: Fact[], matches: (fact: Fact) => boolean): number => {
  for (let index = facts.length - 1; index >= 0; index -= 1) {
    const fact = facts[index];

    if (fact !== undefined && matches(fact)) {
      return index;
    }
  }

  return -1;
};

const stateOnly = (
  state: InstructionStateName,
  rejection: InstructionRejection | null,
): InstructionState => ({ state, claim: null, rejection });

const isDecision = (fact: Fact): fact is DecisionFact =>
  fact.kind === 'reject' || fact.kind === 'accept';

export const dropStaleDecisions = (own: Fact[]): Fact[] => {
  const latestItem = own.findLast(isSubmittedLog)?.item;

  return own.filter((fact) => !isDecision(fact) || fact.item === latestItem);
};

const endsClaim = (fact: Fact): boolean => fact.kind === 'release' || fact.kind === 'reject';

// A reject comes from another machine, whose clock may sort it before the claim it ends. The
// submission comes from the claim's own machine, so it orders the claim reliably.
const rejectedAfter = (kept: Fact[], claimIndex: number): boolean =>
  kept.some((fact) => fact.kind === 'reject') && lastIndexWhere(kept, isSubmittedLog) > claimIndex;

export const selectLastClaim = (own: Fact[]): ClaimFact | undefined => {
  const kept = dropStaleDecisions(own);
  const holderIndex = lastIndexWhere(kept, (fact) => fact.kind === 'claim' || endsClaim(fact));
  const holderFact = kept[holderIndex];

  if (holderFact?.kind !== 'claim' || rejectedAfter(kept, holderIndex)) {
    return undefined;
  }

  return holderFact;
};

const rejectionOf = (own: Fact[]): InstructionRejection | null => {
  const reject = own.findLast((fact) => fact.kind === 'reject');

  if (reject?.kind !== 'reject') {
    return null;
  }

  return { item: reject.item, reason: reject.reason, at: reject.at };
};

export const deriveInstructionStateFromOwnFacts = (
  ticket: StatusTicket,
  ownFacts: Fact[],
  now: Date,
): InstructionState => {
  const own = dropStaleDecisions(ownFacts);
  const { status } = ticket.frontMatter;
  const rejection = rejectionOf(own);

  if (status === 'canceled' || status === 'draft') {
    return stateOnly(status, rejection);
  }

  if (own.some((fact) => fact.kind === 'accept')) {
    return stateOnly('done', rejection);
  }

  const claimIndex = lastIndexWhere(own, (fact) => fact.kind === 'claim');
  const submittedIndex = lastIndexWhere(own, isSubmittedLog);

  if (submittedIndex > claimIndex && rejection === null) {
    return stateOnly('submitted', rejection);
  }

  const holderFact = selectLastClaim(own);

  if (holderFact !== undefined && new Date(holderFact.leaseEnd) > now) {
    return {
      state: 'active',
      claim: {
        holder: holderFact.holder,
        leaseEnd: holderFact.leaseEnd,
        session: holderFact.session ?? null,
        sessionLog: holderFact.sessionLog ?? null,
      },
      rejection,
    };
  }

  return stateOnly('open', rejection);
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
