import { deriveSliceState } from './sliceState.ts';
import type { SliceIndex, SliceTicket } from './sliceState.ts';

export type PlanStateName = 'draft' | 'open' | 'canceled' | 'done';

const isCanceled = (ticket: SliceTicket): boolean => ticket.frontMatter.status === 'canceled';

const isFinishedTask = (task: SliceTicket): boolean =>
  task.frontMatter.status === 'done' || isCanceled(task);

// Archived slices and tasks count like any other: archive hides a ticket but does not complete it.
export const derivePlanState = (plan: SliceTicket, index: SliceIndex, now: Date): PlanStateName => {
  const { status } = plan.frontMatter;

  if (status !== 'open') {
    return status;
  }

  const slices = (index.slicesByPlan.get(plan.id) ?? []).filter((slice) => !isCanceled(slice));
  const tasks = index.tasksByParent.get(plan.id) ?? [];
  const hasWork = slices.length > 0 || tasks.some((task) => !isCanceled(task));

  if (!hasWork) {
    return 'open';
  }

  const slicesDone = slices.every((slice) => deriveSliceState(slice, index, now).state === 'done');

  return slicesDone && tasks.every(isFinishedTask) ? 'done' : 'open';
};
