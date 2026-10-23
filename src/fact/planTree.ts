import type { TicketId } from '../ticket/ticket.ts';
import type { Fact } from './factLine.ts';
import { compareRank } from './rankOrder.ts';
import { buildSliceIndex, deriveSliceState, selectSlicePr } from './sliceState.ts';
import type { SliceStateName } from './sliceState.ts';
import { deriveTaskState } from './taskState.ts';
import type { TaskStateName, TaskTicket } from './taskState.ts';

interface TreeTask {
  id: TicketId;
  title: string;
  state: TaskStateName;
}

interface TreeSlice {
  id: TicketId;
  title: string;
  state: SliceStateName;
  pr: number | null;
  tasks: TreeTask[];
}

interface TreePlanHeader {
  id: TicketId;
  title: string;
  status: TaskTicket['frontMatter']['status'];
}

export interface TreeGroup {
  plan: TreePlanHeader | null;
  slices: TreeSlice[];
}

const isShown = (ticket: TaskTicket): boolean =>
  ticket.frontMatter.archived === undefined && ticket.frontMatter.status !== 'canceled';

const ofKind = (tickets: TaskTicket[], kind: TaskTicket['frontMatter']['kind']): TaskTicket[] =>
  tickets.filter((ticket) => ticket.frontMatter.kind === kind && isShown(ticket));

const byRank = (tickets: TaskTicket[]): TaskTicket[] => tickets.toSorted(compareRank);

export const buildPlanTree = (tickets: TaskTicket[], facts: Fact[], now: Date): TreeGroup[] => {
  const index = buildSliceIndex(tickets, facts);

  const tasksByParent = Map.groupBy(
    byRank(ofKind(tickets, 'task')),
    (task) => task.frontMatter.parent,
  );

  const treeSlice = (slice: TaskTicket): TreeSlice => {
    const derived = deriveSliceState(slice, index, now);

    const tasks =
      derived.state === 'active'
        ? (tasksByParent.get(slice.id) ?? []).map((task) => ({
            id: task.id,
            title: task.frontMatter.title,
            state: deriveTaskState(task, facts, now).state,
          }))
        : [];

    return {
      id: slice.id,
      title: slice.frontMatter.title,
      state: derived.state,
      pr: selectSlicePr(slice.id, index)?.number ?? null,
      tasks,
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
