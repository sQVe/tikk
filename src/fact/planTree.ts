import type { TicketId } from '../ticket/ticket.ts';
import type { Fact } from './factLine.ts';
import { deriveInstructionState } from './instructionState.ts';
import type { InstructionStateName, InstructionTicket } from './instructionState.ts';
import { compareRank } from './rankOrder.ts';
import { buildSliceIndex, deriveSliceState, selectSlicePr } from './sliceState.ts';
import type { SliceStateName } from './sliceState.ts';

interface TreeInstruction {
  id: TicketId;
  title: string;
  state: InstructionStateName;
}

interface TreeSlice {
  id: TicketId;
  title: string;
  state: SliceStateName;
  pr: number | null;
  instructions: TreeInstruction[];
}

interface TreePlanHeader {
  id: TicketId;
  title: string;
  status: InstructionTicket['frontMatter']['status'];
}

export interface TreeGroup {
  plan: TreePlanHeader | null;
  slices: TreeSlice[];
}

const isShown = (ticket: InstructionTicket): boolean =>
  ticket.frontMatter.archived === undefined && ticket.frontMatter.status !== 'canceled';

const ofKind = (
  tickets: InstructionTicket[],
  kind: InstructionTicket['frontMatter']['kind'],
): InstructionTicket[] =>
  tickets.filter((ticket) => ticket.frontMatter.kind === kind && isShown(ticket));

const byRank = (tickets: InstructionTicket[]): InstructionTicket[] => tickets.toSorted(compareRank);

export const buildPlanTree = (
  tickets: InstructionTicket[],
  facts: Fact[],
  now: Date,
): TreeGroup[] => {
  const index = buildSliceIndex(tickets, facts);

  const instructionsByParent = Map.groupBy(
    byRank(ofKind(tickets, 'instruction')),
    (instruction) => instruction.frontMatter.parent,
  );

  const treeSlice = (slice: InstructionTicket): TreeSlice => {
    const derived = deriveSliceState(slice, index, now);

    const instructions =
      derived.state === 'active'
        ? (instructionsByParent.get(slice.id) ?? []).map((instruction) => ({
            id: instruction.id,
            title: instruction.frontMatter.title,
            state: deriveInstructionState(instruction, facts, now).state,
          }))
        : [];

    return {
      id: slice.id,
      title: slice.frontMatter.title,
      state: derived.state,
      pr: selectSlicePr(slice.id, index)?.number ?? null,
      instructions,
    };
  };

  const plans = byRank(ofKind(tickets, 'plan'));
  const planIds = new Set(plans.map((plan) => plan.id));
  const slices = byRank(ofKind(tickets, 'slice'));
  const slicesByPlan = Map.groupBy(slices, (slice) => slice.frontMatter.parent);

  const groups: TreeGroup[] = plans.map((plan) => ({
    plan: { id: plan.id, title: plan.frontMatter.title, status: plan.frontMatter.status },
    slices: (slicesByPlan.get(plan.id) ?? []).map(treeSlice),
  }));

  const orphans = slices.filter((slice) => {
    const { parent } = slice.frontMatter;

    return parent === undefined || !planIds.has(parent);
  });

  if (orphans.length > 0) {
    groups.push({ plan: null, slices: orphans.map(treeSlice) });
  }

  return groups;
};
