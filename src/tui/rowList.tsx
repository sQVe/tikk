import type { ReactNode } from 'react';

// A row without a ticket ID stands for a group, such as the slices that have no plan.
export interface ListRow {
  key: string;
  id: string | null;
  text: string;
}

export interface RowListProps {
  rows: readonly ListRow[];
  selected: number;
  height: number;
  emptyMessage: string;
}

export const singleLine = (text: string): string => text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ');

const firstVisibleIndex = (selected: number, height: number): number =>
  Math.max(0, selected - height + 1);

export const RowList = ({ rows, selected, height, emptyMessage }: RowListProps): ReactNode => {
  if (rows.length === 0) {
    return <text>{emptyMessage}</text>;
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
