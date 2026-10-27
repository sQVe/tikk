import type { TreeGroup } from '../cli/cli.ts';
import { singleLine } from './rowList.tsx';
import type { DetailFact, ListRow } from './rowList.tsx';

const planRowOf = (plan: TreeGroup['plan']): ListRow =>
  plan === null
    ? { key: 'no-plan', id: null, text: 'No plan', facts: [] }
    : {
        key: plan.id,
        id: plan.id,
        text: `${plan.id}  ${singleLine(plan.title)}  ${plan.state}`,
        facts: [
          { label: 'ID', value: plan.id },
          { label: 'Title', value: singleLine(plan.title) },
          { label: 'Kind', value: 'Plan' },
          { label: 'State', value: plan.state },
        ],
      };

const sliceFactsOf = (slice: TreeGroup['slices'][number]): DetailFact[] => {
  const pr = slice.pr === null ? [] : [{ label: 'PR', value: `#${slice.pr}` }];

  return [
    { label: 'ID', value: slice.id },
    { label: 'Title', value: singleLine(slice.title) },
    { label: 'Kind', value: 'Slice' },
    { label: 'State', value: slice.state },
    ...pr,
  ];
};

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
          facts: sliceFactsOf(slice),
        },
        ...slice.instructions.map((instruction) => ({
          key: instruction.id,
          id: instruction.id,
          text: `    ${instruction.id}  ${singleLine(instruction.title)}  ${instruction.state}`,
          facts: [
            { label: 'ID', value: instruction.id },
            { label: 'Title', value: singleLine(instruction.title) },
            { label: 'Kind', value: 'Instruction' },
            { label: 'State', value: instruction.state },
          ],
        })),
      ];
    }),
  ]);
