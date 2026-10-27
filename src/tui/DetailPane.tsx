import type { ReactNode } from 'react';

import { errorsOfTicket } from './fileErrors.ts';
import type { TicketFileError } from './fileErrors.ts';
import type { Palette } from './palette.ts';
import { singleLine } from './rowList.tsx';
import type { DetailFact, ListRow } from './rowList.tsx';

const labelWidth = 8;

const fileFactsOf = (id: string | null, errors: readonly TicketFileError[]): DetailFact[] => {
  if (id === null) {
    return [];
  }

  return errorsOfTicket(errors, id).flatMap((error) => [
    { label: 'File', value: error.path },
    { label: 'Error', value: error.message },
  ]);
};

const factsOf = (row: ListRow, errors: readonly TicketFileError[]): DetailFact[] => [
  ...row.facts,
  ...fileFactsOf(row.id, errors),
];

export const DetailPane = (props: {
  row: ListRow | undefined;
  errors: readonly TicketFileError[];
  palette: Palette;
  width: number;
}): ReactNode => {
  const { palette, row } = props;

  return (
    <box
      flexDirection="column"
      width={props.width}
      flexShrink={0}
      paddingLeft={1}
      border={['left']}
      borderColor={palette.dim}
    >
      {row === undefined
        ? null
        : factsOf(row, props.errors).map((fact) => (
            <box flexDirection="row" key={`${fact.label}:${fact.value}`}>
              <text fg={palette.dim} width={labelWidth} flexShrink={0}>
                {fact.label}
              </text>
              <text fg={palette.text} wrapMode="char" flexShrink={1}>
                {singleLine(fact.value)}
              </text>
            </box>
          ))}
    </box>
  );
};
