import type { ReactNode } from 'react';

import type { TreeGroup } from '../cli/cli.ts';
import { firstVisibleIndex, singleLine } from './homeView.tsx';

// A row without a ticket id is the group of slices that have no plan.
export interface TreeRow {
  key: string;
  id: string | null;
  text: string;
}

export interface TreeViewProps {
  rows: readonly TreeRow[];
  selected: number;
  height: number;
}

const planRowOf = (plan: TreeGroup['plan']): TreeRow =>
  plan === null
    ? { key: 'no-plan', id: null, text: 'No plan' }
    : { key: plan.id, id: plan.id, text: `${plan.id}  ${singleLine(plan.title)}  ${plan.status}` };

export const treeRowsOf = (groups: readonly TreeGroup[]): TreeRow[] =>
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
        ...slice.tasks.map((task) => ({
          key: task.id,
          id: task.id,
          text: `    ${task.id}  ${singleLine(task.title)}  ${task.state}`,
        })),
      ];
    }),
  ]);

export const TreeView = ({ rows, selected, height }: TreeViewProps): ReactNode => {
  if (rows.length === 0) {
    return <text>No plans or slices.</text>;
  }

  const first = firstVisibleIndex(selected, height);
  const visible = rows.slice(first, first + height);

  return (
    <box flexDirection="column">
      {visible.map((row, offset) => {
        const isSelected = first + offset === selected;

        return (
          <text
            wrapMode="none"
            truncate
            height={1}
            key={row.key}
            {...(isSelected ? { bold: true } : {})}
          >
            {`${isSelected ? '>' : ' '} ${row.text}`}
          </text>
        );
      })}
    </box>
  );
};
