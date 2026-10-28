import { TextAttributes } from '@opentui/core';
import type { ReactNode } from 'react';

import type { TreeStateName } from '../cli/cli.ts';
import type { Palette } from './palette.ts';
import type { FoldMark, IconKind, IconSet } from './ticketIcons.ts';

export interface DetailFact {
  label: string;
  value: string;
}

interface RowMarks {
  depth: number;
  kind: IconKind;
  state: TreeStateName | null;
  fold: FoldMark | null;
  attention: number;
}

export interface ListRow {
  key: string;
  id: string | null;
  text: string;
  facts: readonly DetailFact[];
  marks?: RowMarks;
}

export interface RowListProps {
  rows: readonly ListRow[];
  selected: number;
  height: number;
  emptyMessage: string;
  palette: Palette;
  icons: IconSet;
}

export const singleLine = (text: string): string => text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ');

const firstVisibleIndex = (selected: number, height: number): number =>
  Math.max(0, selected - height + 1);

const markedText = (row: ListRow, icons: IconSet): string => {
  const { marks } = row;

  if (marks === undefined) {
    return row.text;
  }

  const fold = marks.fold === null ? ' ' : icons.folds[marks.fold];
  const state = marks.state === null ? '' : ` ${icons.states[marks.state]}`;
  const attention = marks.attention > 0 ? `  ${icons.attention} ${marks.attention}` : '';

  return `${'  '.repeat(marks.depth)}${fold} ${icons.kinds[marks.kind]}${state} ${row.text}${attention}`;
};

export const RowList = ({
  rows,
  selected,
  height,
  emptyMessage,
  palette,
  icons,
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
            {`${isSelected ? '>' : ' '} ${markedText(row, icons)}`}
          </text>
        );
      })}
    </box>
  );
};
