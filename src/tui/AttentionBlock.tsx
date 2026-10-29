import type { ReactNode } from 'react';

import { itemSubject } from '../cli/cli.ts';
import type { NeedView } from '../cli/cli.ts';
import { ageLabelOf } from './homeView.tsx';
import type { Palette } from './palette.ts';
import { wrapCells } from './textLayout.ts';
import type { IconSet } from './ticketIcons.ts';

const lineBreak = /\r\n|[\r\n\u2028\u2029]/;

const subjectLinesOf = (need: NeedView): string[] => {
  const hasSubject = need.reason === 'question' || need.reason === 'blockedFinding';

  return hasSubject ? itemSubject(need).split(lineBreak) : [];
};

const needLinesOf = (need: NeedView, icons: IconSet): string[] => {
  const age = need.ageSeconds === null ? '' : `  ${ageLabelOf(need.ageSeconds)}`;

  return [`${icons.attention} ${need.reason}${age}`, ...subjectLinesOf(need)];
};

export const attentionLinesOf = (
  needs: readonly NeedView[],
  id: string,
  icons: IconSet,
  columns: number,
): string[] =>
  needs
    .filter((need) => need.id === id)
    .flatMap((need) => needLinesOf(need, icons))
    .flatMap((line) => wrapCells(line, Math.max(1, columns)));

export const cutAttention = (lines: readonly string[], limit: number): string[] => {
  if (lines.length <= limit) {
    return [...lines];
  }

  const kept = Math.max(0, limit - 1);

  return [...lines.slice(0, kept), `+${lines.length - kept} more`];
};

export const AttentionBlock = (props: {
  lines: readonly string[];
  palette: Palette;
}): ReactNode => (
  <>
    {props.lines.map((line, index) => (
      <text
        key={`attention-${index}`}
        fg={props.palette.key}
        wrapMode="none"
        truncate
        height={1}
        flexShrink={0}
      >
        {line}
      </text>
    ))}
  </>
);
