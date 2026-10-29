import { TextAttributes } from '@opentui/core';
import type { ReactNode } from 'react';

import type { TicketDetail } from '../cli/cli.ts';
import { detailOf } from './detailState.ts';
import type { DetailState } from './detailState.ts';
import { errorsOfTicket } from './fileErrors.ts';
import type { TicketFileError } from './fileErrors.ts';
import type { Palette } from './palette.ts';
import { kindLabels } from './projectTree.ts';
import { singleLine } from './rowList.tsx';
import type { IconSet } from './ticketIcons.ts';

const ticketLinesOf = (detail: TicketDetail, icons: IconSet): string[] => {
  const { ticket, state } = detail;
  const kind = `${icons.kinds[ticket.kind]} ${icons.states[state]}`;
  const parent = ticket.parent === null ? '' : ` › ${ticket.parent}`;

  return [
    `${kind} ${ticket.id}  ${singleLine(ticket.title)}`,
    `${kindLabels[ticket.kind]}  ${state}`,
    `${ticket.project}${parent}`,
  ];
};

export const headerLinesOf = (
  state: DetailState,
  id: string,
  icons: IconSet,
  errors: readonly TicketFileError[],
): string[] => {
  const detail = detailOf(state.load);
  const ticketLines = detail === undefined ? [id] : ticketLinesOf(detail, icons);

  const errorLines = errorsOfTicket(errors, id).flatMap((error) => [
    `File   ${error.path}`,
    `Error  ${singleLine(error.message)}`,
  ]);

  return [...ticketLines, ...errorLines];
};

export const DetailHeader = (props: { lines: readonly string[]; palette: Palette }): ReactNode => (
  <>
    {props.lines.map((line, index) => (
      <text
        key={`header-${index}`}
        fg={props.palette.text}
        wrapMode="none"
        truncate
        height={1}
        flexShrink={0}
        attributes={index === 0 ? TextAttributes.BOLD : TextAttributes.NONE}
      >
        {line}
      </text>
    ))}
  </>
);
