import type { ReactNode } from 'react';

import type { NeedView } from '../cli/cli.ts';

export interface HomeViewProps {
  items: readonly NeedView[];
  selected: number;
  height: number;
}

export const singleLine = (text: string): string => text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ');

const firstVisibleIndex = (selected: number, height: number): number =>
  Math.max(0, selected - height + 1);

const rowText = (item: NeedView, isSelected: boolean): string => {
  const marker = isSelected ? '>' : ' ';

  return `${marker} ${item.id}  ${item.reason}  ${singleLine(item.title)}`;
};

export const HomeView = ({ items, selected, height }: HomeViewProps): ReactNode => {
  if (items.length === 0) {
    return <text>Nothing needs you.</text>;
  }

  const first = firstVisibleIndex(selected, height);
  const visible = items.slice(first, first + height);

  return (
    <box flexDirection="column">
      {visible.map((item, offset) => (
        <text
          wrapMode="none"
          truncate
          height={1}
          key={`${item.id}:${item.reason}`}
          {...(first + offset === selected ? { bold: true } : {})}
        >
          {rowText(item, first + offset === selected)}
        </text>
      ))}
    </box>
  );
};
