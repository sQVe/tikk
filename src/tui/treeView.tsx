import type { ReactNode } from 'react';

import type { TreeGroup } from '../cli/cli.ts';
import { firstVisibleIndex, singleLine } from './homeView.tsx';

export interface TreeViewProps {
  groups: readonly TreeGroup[];
  selected: number;
  height: number;
}

export const treeRowsOf = (groups: readonly TreeGroup[]): string[] =>
  groups.flatMap((group) => [
    group.plan === null
      ? 'No plan'
      : `${group.plan.id}  ${singleLine(group.plan.title)}  ${group.plan.status}`,
    ...group.slices.flatMap((slice) => {
      const pr = slice.pr === null ? '' : `  #${slice.pr}`;

      return [
        `  ${slice.id}  ${singleLine(slice.title)}  ${slice.state}${pr}`,
        ...slice.tasks.map((task) => `    ${task.id}  ${singleLine(task.title)}  ${task.state}`),
      ];
    }),
  ]);

export const TreeView = ({ groups, selected, height }: TreeViewProps): ReactNode => {
  const rows = treeRowsOf(groups);

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
            key={first + offset}
            {...(isSelected ? { bold: true } : {})}
          >
            {`${isSelected ? '>' : ' '} ${row}`}
          </text>
        );
      })}
    </box>
  );
};
