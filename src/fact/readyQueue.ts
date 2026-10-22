import type { Fact } from './factLine.ts';
import { compareRank } from './rankOrder.ts';
import { buildSliceIndex, deriveSliceState } from './sliceState.ts';
import type { SliceStateName } from './sliceState.ts';
import { deriveTaskStateFromOwnFacts } from './taskState.ts';
import type { TaskClaim, TaskStateName, TaskTicket } from './taskState.ts';

export interface ReadyScope {
  kind?: 'task' | 'slice';
  project?: string;
  parent?: string;
}

interface Blocker {
  id: string;
  state: string;
}

type ReadyStateName = TaskStateName | SliceStateName;

interface Consideration {
  state: ReadyStateName;
  claim: TaskClaim | null;
}

interface ReadyCandidate<Ticket extends TaskTicket> {
  ticket: Ticket;
  state: ReadyStateName;
}

interface SkippedTask<Ticket extends TaskTicket> {
  ticket: Ticket;
  reason: 'blocked' | 'active' | 'submitted';
  blockers?: Blocker[];
  holder?: string;
  leaseEnd?: string;
}

export interface ReadySelection<Ticket extends TaskTicket> {
  candidates: ReadyCandidate<Ticket>[];
  skipped: SkippedTask<Ticket>[];
}

const consideredStates = new Set<ReadyStateName>(['open', 'active', 'submitted', 'planned']);
const clearingStates = new Set(['done', 'canceled', 'closed']);

const inScope = (ticket: TaskTicket, scope: ReadyScope): boolean => {
  const { frontMatter } = ticket;

  if (scope.project !== undefined && frontMatter.project !== scope.project) {
    return false;
  }

  return scope.parent === undefined || frontMatter.parent === scope.parent;
};

const isCandidateKind = (ticket: TaskTicket, scope: ReadyScope): boolean =>
  ticket.frontMatter.kind === (scope.kind ?? 'task') && ticket.frontMatter.archived === undefined;

const deriveStates = (
  tickets: TaskTicket[],
  facts: Fact[],
  now: Date,
): Map<string, Consideration> => {
  const index = buildSliceIndex(tickets, facts);
  const states = new Map<string, Consideration>();

  for (const ticket of tickets) {
    const { kind, status } = ticket.frontMatter;

    if (kind === 'task') {
      states.set(
        ticket.id,
        deriveTaskStateFromOwnFacts(ticket, index.factsByTicket.get(ticket.id) ?? [], now),
      );
    }

    if (kind === 'slice' && status === 'open') {
      states.set(ticket.id, {
        state: deriveSliceState(ticket, index, now).state,
        claim: null,
      });
    }
  }

  return states;
};

const blockerState = (
  target: TaskTicket | undefined,
  states: Map<string, Consideration>,
): string => {
  if (target === undefined) {
    return 'missing';
  }

  return states.get(target.id)?.state ?? target.frontMatter.status;
};

export const selectReady = <Ticket extends TaskTicket>(
  tickets: Ticket[],
  facts: Fact[],
  now: Date,
  scope: ReadyScope,
): ReadySelection<Ticket> => {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const states = deriveStates(tickets, facts, now);

  const considered: {
    ticket: Ticket;
    state: ReadyStateName;
    claim: TaskClaim | null;
  }[] = [];

  for (const ticket of tickets) {
    if (!isCandidateKind(ticket, scope) || !inScope(ticket, scope)) {
      continue;
    }

    const derived = states.get(ticket.id);

    if (derived !== undefined && consideredStates.has(derived.state)) {
      considered.push({ ticket, state: derived.state, claim: derived.claim });
    }
  }

  considered.sort((left, right) => compareRank(left.ticket, right.ticket));

  const candidates: ReadyCandidate<Ticket>[] = [];
  const skipped: SkippedTask<Ticket>[] = [];
  const pending: SkippedTask<Ticket>[] = [];

  for (const { ticket, state, claim } of considered) {
    if (state === 'submitted') {
      pending.push({ ticket, reason: 'submitted' });

      continue;
    }

    if (claim !== null) {
      pending.push({ ticket, reason: 'active', holder: claim.holder, leaseEnd: claim.leaseEnd });

      continue;
    }

    const blockers = ticket.frontMatter.blockedBy
      .map((id) => ({ id, state: blockerState(byId.get(id), states) }))
      .filter((blocker) => !clearingStates.has(blocker.state));

    if (blockers.length > 0) {
      pending.push({ ticket, reason: 'blocked', blockers });

      continue;
    }

    candidates.push({ ticket, state });
    skipped.push(...pending);
    pending.length = 0;
  }

  if (candidates.length === 0) {
    skipped.push(...pending);
  }

  return { candidates, skipped };
};
