import type { ProjectName, TicketId } from '../ticket/ticket.ts';
import type { Fact } from './factLine.ts';
import { deriveInstructionStateFromOwnFacts } from './instructionState.ts';
import type { InstructionStateName, InstructionTicket } from './instructionState.ts';
import { derivePlanState } from './planState.ts';
import type { PlanStateName } from './planState.ts';
import { compareRank } from './rankOrder.ts';
import { buildSliceIndex, deriveSliceState, selectSlicePr } from './sliceState.ts';
import type { SliceIndex, SliceStateName } from './sliceState.ts';

type TaskStateName = 'open' | 'done';

export type TreeStateName = PlanStateName | SliceStateName | InstructionStateName | TaskStateName;

interface TreeTask {
  id: TicketId;
  title: string;
  state: TaskStateName;
}

interface TreeInstruction {
  id: TicketId;
  title: string;
  state: InstructionStateName;
}

export interface TreeSlice {
  id: TicketId;
  title: string;
  state: SliceStateName;
  pr: number | null;
  tasks: TreeTask[];
  instructions: TreeInstruction[];
}

interface TreePlan {
  id: TicketId;
  title: string;
  state: PlanStateName;
  tasks: TreeTask[];
  slices: TreeSlice[];
}

interface TreeInboxEntry {
  id: TicketId;
  title: string;
  kind: 'task' | 'instruction';
  state: TaskStateName | InstructionStateName;
}

export interface TreeProject {
  name: ProjectName;
  inbox: TreeInboxEntry[];
  plans: TreePlan[];
  slices: TreeSlice[];
}

export interface ProjectTree {
  current: ProjectName | null;
  projects: TreeProject[];
}

interface TreeInput {
  shown: InstructionTicket[];
  index: SliceIndex;
  now: Date;
}

const isShown = (ticket: InstructionTicket): boolean =>
  ticket.frontMatter.archived === undefined && ticket.frontMatter.status !== 'canceled';

const ofKind = (
  tickets: InstructionTicket[],
  kind: InstructionTicket['frontMatter']['kind'],
): InstructionTicket[] => tickets.filter((ticket) => ticket.frontMatter.kind === kind);

const isTaskLike = (ticket: InstructionTicket): boolean =>
  ticket.frontMatter.kind === 'task' || ticket.frontMatter.kind === 'instruction';

const treeTask = (task: InstructionTicket): TreeTask => ({
  id: task.id,
  title: task.frontMatter.title,
  state: task.frontMatter.status === 'done' ? 'done' : 'open',
});

const projectOrder =
  (current: ProjectName | null) =>
  (left: ProjectName, right: ProjectName): number => {
    if ((left === current) !== (right === current)) {
      return left === current ? -1 : 1;
    }

    return left < right ? -1 : 1;
  };

const buildProjects = (input: TreeInput): ((name: ProjectName) => TreeProject) => {
  const { shown, index, now } = input;
  const shownById = new Map(shown.map((ticket) => [ticket.id, ticket]));

  const shownParentOf = (ticket: InstructionTicket): TicketId | undefined => {
    const { parent, project } = ticket.frontMatter;
    const found = parent === undefined ? undefined : shownById.get(parent);

    return found?.frontMatter.project === project ? parent : undefined;
  };

  const childrenByParent = (tickets: InstructionTicket[]) => Map.groupBy(tickets, shownParentOf);
  const tasksByParent = childrenByParent(ofKind(shown, 'task'));
  const instructionsByParent = childrenByParent(ofKind(shown, 'instruction'));
  const slicesByParent = childrenByParent(ofKind(shown, 'slice'));
  const isLoose = (ticket: InstructionTicket): boolean => shownParentOf(ticket) === undefined;

  const tasksOf = (parent: TicketId): TreeTask[] => (tasksByParent.get(parent) ?? []).map(treeTask);

  const treeInstruction = (instruction: InstructionTicket): TreeInstruction => ({
    id: instruction.id,
    title: instruction.frontMatter.title,
    state: deriveInstructionStateFromOwnFacts(
      instruction,
      index.factsByTicket.get(instruction.id) ?? [],
      now,
    ).state,
  });

  const inboxEntry = (ticket: InstructionTicket): TreeInboxEntry => {
    if (ticket.frontMatter.kind === 'instruction') {
      return { ...treeInstruction(ticket), kind: 'instruction' };
    }

    return { ...treeTask(ticket), kind: 'task' };
  };

  const treeSlice = (slice: InstructionTicket): TreeSlice => ({
    id: slice.id,
    title: slice.frontMatter.title,
    state: deriveSliceState(slice, index, now).state,
    pr: selectSlicePr(slice.id, index)?.number ?? null,
    tasks: tasksOf(slice.id),
    instructions: (instructionsByParent.get(slice.id) ?? []).map(treeInstruction),
  });

  const treePlan = (plan: InstructionTicket): TreePlan => ({
    id: plan.id,
    title: plan.frontMatter.title,
    state: derivePlanState(plan, index, now),
    tasks: tasksOf(plan.id),
    slices: (slicesByParent.get(plan.id) ?? []).map(treeSlice),
  });

  return (name) => {
    const inProject = (ticket: InstructionTicket) => ticket.frontMatter.project === name;
    const roots = shown.filter((ticket) => inProject(ticket) && isLoose(ticket));

    return {
      name,
      inbox: roots.filter(isTaskLike).map(inboxEntry),
      plans: ofKind(roots, 'plan').map(treePlan),
      slices: ofKind(roots, 'slice').map(treeSlice),
    };
  };
};

export const buildProjectTree = (
  tickets: InstructionTicket[],
  facts: Fact[],
  now: Date,
  current: ProjectName | null,
  stateTickets: InstructionTicket[],
): ProjectTree => {
  const shown = tickets.filter(isShown).toSorted(compareRank);
  const index = buildSliceIndex(stateTickets, facts);
  const names = [...new Set(shown.map((ticket) => ticket.frontMatter.project))];
  const projectOf = buildProjects({ shown, index, now });

  return { current, projects: names.toSorted(projectOrder(current)).map(projectOf) };
};
