import type { TreeGroup } from '../cli/cli.ts';
import { singleLine } from './rowList.tsx';
import type { ListRow } from './rowList.tsx';

const planRowOf = (plan: TreeGroup['plan']): ListRow =>
  plan === null
    ? { key: 'no-plan', id: null, text: 'No plan' }
    : { key: plan.id, id: plan.id, text: `${plan.id}  ${singleLine(plan.title)}  ${plan.status}` };

export const treeRowsOf = (groups: readonly TreeGroup[]): ListRow[] =>
  groups.flatMap((group) => [
    planRowOf(group.plan),
    ...group.slices.flatMap((slice) => {
      const pr = slice.pr === null ? '' : `  #${slice.pr}`;

      return [
        {
          key: slice.id,
          id: slice.id,
          text: `  ${slice.id}  ${singleLine(slice.title)}  ${slice.state}${pr}`,
        },
        ...slice.instructions.map((instruction) => ({
          key: instruction.id,
          id: instruction.id,
          text: `    ${instruction.id}  ${singleLine(instruction.title)}  ${instruction.state}`,
        })),
      ];
    }),
  ]);
