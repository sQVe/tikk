import { TextAttributes } from '@opentui/core';
import type { ReactNode } from 'react';

import type { Palette } from './palette.ts';

export interface DetailFact {
  label: string;
  value: string;
}

export interface ListRow {
  key: string;
  id: string | null;
  text: string;
  facts: readonly DetailFact[];
}

export interface RowListProps {
  rows: readonly ListRow[];
  selected: number;
  height: number;
  emptyMessage: string;
  palette: Palette;
}

export const singleLine = (text: string): string => text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ');

const firstVisibleIndex = (selected: number, height: number): number =>
  Math.max(0, selected - height + 1);

export const RowList = ({
  rows,
  selected,
  height,
  emptyMessage,
  palette,
}: RowListProps): ReactNode => {
  if (rows.length === 0) {
    return <text fg={palette.text}>{emptyMessage}</text>;
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
            fg={palette.text}
            attributes={isSelected ? TextAttributes.BOLD : TextAttributes.NONE}
          >
            {`${isSelected ? '>' : ' '} ${row.text}`}
          </text>
        );
      })}
    </box>
  );
};
