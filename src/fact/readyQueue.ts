import type { Fact } from './factLine.ts';
import { deriveTaskState } from './taskState.ts';
import type { TaskStateName, TaskTicket } from './taskState.ts';

export interface ReadyScope {
  project?: string;
  parent?: string;
}

interface Blocker {
  id: string;
  state: string;
}

interface ReadyCandidate<Ticket extends TaskTicket> {
  ticket: Ticket;
  state: TaskStateName;
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

const consideredStates = new Set<TaskStateName>(['open', 'active', 'submitted']);
const clearingStates = new Set(['done', 'canceled', 'closed']);

const inScope = (ticket: TaskTicket, scope: ReadyScope): boolean => {
  const { frontMatter } = ticket;

  if (scope.project !== undefined && frontMatter.project !== scope.project) {
    return false;
  }

  return scope.parent === undefined || frontMatter.parent === scope.parent;
};

const compareRank = (left: TaskTicket, right: TaskTicket): number => {
  const leftRank = left.frontMatter.rank;
  const rightRank = right.frontMatter.rank;

  if (leftRank !== undefined && rightRank !== undefined && leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  if ((leftRank === undefined) !== (rightRank === undefined)) {
    return leftRank === undefined ? 1 : -1;
  }

  return left.id < right.id ? -1 : Number(left.id > right.id);
};

const blockerState = (target: TaskTicket | undefined, facts: Fact[], now: Date): string => {
  if (target === undefined) {
    return 'missing';
  }

  if (target.frontMatter.kind === 'issue') {
    return target.frontMatter.status;
  }

  return deriveTaskState(target, facts, now).state;
};

export const selectReady = <Ticket extends TaskTicket>(
  tickets: Ticket[],
  facts: Fact[],
  now: Date,
  scope: ReadyScope,
): ReadySelection<Ticket> => {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));

  const considered: {
    ticket: Ticket;
    state: TaskStateName;
    claim: ReturnType<typeof deriveTaskState>['claim'];
  }[] = [];

  for (const ticket of tickets) {
    const { frontMatter } = ticket;

    if (frontMatter.kind !== 'task' || frontMatter.archived !== undefined) {
      continue;
    }

    if (!inScope(ticket, scope)) {
      continue;
    }

    const { state, claim } = deriveTaskState(ticket, facts, now);

    if (consideredStates.has(state)) {
      considered.push({ ticket, state, claim });
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
      .map((id) => ({ id, state: blockerState(byId.get(id), facts, now) }))
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
