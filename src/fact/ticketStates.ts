import { deriveInstructionStateFromOwnFacts } from './instructionState.ts';
import type {
  InstructionClaim,
  InstructionStateName,
  InstructionTicket,
} from './instructionState.ts';
import { derivePlanState } from './planState.ts';
import type { PlanStateName } from './planState.ts';
import { deriveSliceState } from './sliceState.ts';
import type { SliceIndex, SliceStateName } from './sliceState.ts';

export type ReadyStateName = InstructionStateName | SliceStateName | PlanStateName;

export interface Consideration {
  state: ReadyStateName;
  claim: InstructionClaim | null;
}

export const clearingStates = new Set(['done', 'canceled']);

export const deriveStates = (
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

export const blockerState = (
  target: InstructionTicket | undefined,
  states: Map<string, Consideration>,
): string => {
  if (target === undefined) {
    return 'missing';
  }

  return states.get(target.id)?.state ?? target.frontMatter.status;
};
