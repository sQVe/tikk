import type { Fact } from './factLine.ts';
import { deriveInstructionStateFromOwnFacts } from './instructionState.ts';
import type {
  InstructionClaim,
  InstructionStateName,
  InstructionTicket,
} from './instructionState.ts';
import { derivePlanState } from './planState.ts';
import type { PlanStateName } from './planState.ts';
import { compareRank } from './rankOrder.ts';
import { buildSliceIndex, deriveSliceState, selectSlicePr } from './sliceState.ts';
import type { SliceIndex, SliceStateName } from './sliceState.ts';

export interface ReadyScope {
  kind?: 'instruction' | 'slice';
  project?: string;
  parent?: string;
}

interface Blocker {
  id: string;
  state: string;
  via?: string;
}

interface StackParent {
  id: string;
  repository: string;
  number: number;
}

interface ResolvedBlockers {
  blockers: Blocker[];
  stackParents: StackParent[];
}

type ReadyStateName = InstructionStateName | SliceStateName | PlanStateName;

interface Consideration {
  state: ReadyStateName;
  claim: InstructionClaim | null;
}

interface ReadyCandidate<Ticket extends InstructionTicket> {
  ticket: Ticket;
  state: ReadyStateName;
  stackParents?: StackParent[];
}

interface SkippedInstruction<Ticket extends InstructionTicket> {
  ticket: Ticket;
  reason: 'blocked' | 'active' | 'submitted';
  blockers?: Blocker[];
  holder?: string;
  leaseEnd?: string;
}

export interface ReadySelection<Ticket extends InstructionTicket> {
  candidates: ReadyCandidate<Ticket>[];
  skipped: SkippedInstruction<Ticket>[];
}

const consideredStates = new Set<ReadyStateName>(['open', 'active', 'submitted', 'planned']);
const clearingStates = new Set(['done', 'canceled']);

const inScope = (ticket: InstructionTicket, scope: ReadyScope): boolean => {
  const { frontMatter } = ticket;

  if (scope.project !== undefined && frontMatter.project !== scope.project) {
    return false;
  }

  return scope.parent === undefined || frontMatter.parent === scope.parent;
};

const isCandidateKind = (ticket: InstructionTicket, scope: ReadyScope): boolean =>
  ticket.frontMatter.kind === (scope.kind ?? 'instruction') &&
  ticket.frontMatter.archived === undefined;

const deriveStates = (
  tickets: InstructionTicket[],
  index: SliceIndex,
  now: Date,
): Map<string, Consideration> => {
  const states = new Map<string, Consideration>();

  for (const ticket of tickets) {
    const { kind, status } = ticket.frontMatter;

    if (kind === 'instruction') {
      states.set(
        ticket.id,
        deriveInstructionStateFromOwnFacts(ticket, index.factsByTicket.get(ticket.id) ?? [], now),
      );
    }

    if (kind === 'slice' && status === 'open') {
      states.set(ticket.id, {
        state: deriveSliceState(ticket, index, now).state,
        claim: null,
      });
    }

    if (kind === 'plan') {
      states.set(ticket.id, { state: derivePlanState(ticket, index, now), claim: null });
    }
  }

  return states;
};

const blockerState = (
  target: InstructionTicket | undefined,
  states: Map<string, Consideration>,
): string => {
  if (target === undefined) {
    return 'missing';
  }

  return states.get(target.id)?.state ?? target.frontMatter.status;
};

const parentOf = (
  ticket: InstructionTicket,
  byId: Map<string, InstructionTicket>,
): InstructionTicket | undefined => {
  const { parent } = ticket.frontMatter;

  return parent === undefined ? undefined : byId.get(parent);
};

// An instruction inherits from its slice and the slice's plan. A slice inherits from its plan.
const inheritedLevels = (
  ticket: InstructionTicket,
  byId: Map<string, InstructionTicket>,
): InstructionTicket[] => {
  const parent = parentOf(ticket, byId);

  if (parent?.frontMatter.kind === 'plan') {
    return [parent];
  }

  if (parent?.frontMatter.kind !== 'slice') {
    return [];
  }

  const plan = parentOf(parent, byId);

  return plan?.frontMatter.kind === 'plan' ? [parent, plan] : [parent];
};

const stackParentOf = (
  level: InstructionTicket,
  target: InstructionTicket | undefined,
  index: SliceIndex,
): StackParent | undefined => {
  if (level.frontMatter.kind !== 'slice' || target?.frontMatter.kind !== 'slice') {
    return undefined;
  }

  const pr = selectSlicePr(target.id, index);

  if (pr?.state !== 'open') {
    return undefined;
  }

  return { id: target.id, repository: pr.repository, number: pr.number };
};

// A closer level hides a blocker ID that a level further up also names. Only a slice's blockedBy
// stacks on an open slice PR, never an instruction's or a plan's.
const resolveBlockers = (
  ticket: InstructionTicket,
  byId: Map<string, InstructionTicket>,
  states: Map<string, Consideration>,
  index: SliceIndex,
): ResolvedBlockers => {
  const sources = [
    { level: ticket, via: undefined },
    ...inheritedLevels(ticket, byId).map((level) => ({ level, via: level.id })),
  ];

  const seen = new Set<string>();
  const blockers: Blocker[] = [];
  const stackParents: StackParent[] = [];

  for (const { level, via } of sources) {
    for (const id of level.frontMatter.blockedBy) {
      if (seen.has(id)) {
        continue;
      }

      seen.add(id);

      const target = byId.get(id);
      const state = blockerState(target, states);

      if (clearingStates.has(state)) {
        continue;
      }

      const stackParent = stackParentOf(level, target, index);

      if (stackParent !== undefined) {
        stackParents.push(stackParent);

        continue;
      }

      blockers.push({ id, state, ...(via === undefined ? {} : { via }) });
    }
  }

  return { blockers, stackParents };
};

const candidateOf = <Ticket extends InstructionTicket>(
  ticket: Ticket,
  state: ReadyStateName,
  resolved: ResolvedBlockers,
): ReadyCandidate<Ticket> => {
  const stackParents = ticket.frontMatter.kind === 'slice' ? resolved.stackParents : [];

  return { ticket, state, ...(stackParents.length === 0 ? {} : { stackParents }) };
};

export const selectReady = <Ticket extends InstructionTicket>(
  tickets: Ticket[],
  facts: Fact[],
  now: Date,
  scope: ReadyScope,
): ReadySelection<Ticket> => {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const index = buildSliceIndex(tickets, facts);
  const states = deriveStates(tickets, index, now);

  const considered: {
    ticket: Ticket;
    state: ReadyStateName;
    claim: InstructionClaim | null;
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
  const skipped: SkippedInstruction<Ticket>[] = [];
  const pending: SkippedInstruction<Ticket>[] = [];

  for (const { ticket, state, claim } of considered) {
    if (state === 'submitted') {
      pending.push({ ticket, reason: 'submitted' });

      continue;
    }

    if (claim !== null) {
      pending.push({ ticket, reason: 'active', holder: claim.holder, leaseEnd: claim.leaseEnd });

      continue;
    }

    const resolved = resolveBlockers(ticket, byId, states, index);

    if (resolved.blockers.length > 0) {
      pending.push({ ticket, reason: 'blocked', blockers: resolved.blockers });

      continue;
    }

    candidates.push(candidateOf(ticket, state, resolved));
    skipped.push(...pending);
    pending.length = 0;
  }

  if (candidates.length === 0) {
    skipped.push(...pending);
  }

  return { candidates, skipped };
};
