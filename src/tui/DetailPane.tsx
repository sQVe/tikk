import { TextAttributes } from '@opentui/core';
import type { ReactNode } from 'react';

import { AttentionBlock } from './AttentionBlock.tsx';
import { DetailHeader } from './DetailHeader.tsx';
import { DetailTabs } from './DetailTabs.tsx';
import type { DetailWindow } from './detailWindow.ts';
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

// The columns the pane's left border and padding take from its width.
export const detailPaneChromeColumns = 2;

const FactRows = (props: {
  row: ListRow;
  errors: readonly TicketFileError[];
  palette: Palette;
}): ReactNode => {
  const { palette } = props;

  return factsOf(props.row, props.errors).map((fact) => (
    <box flexDirection="row" height={1} flexShrink={0} key={`${fact.label}:${fact.value}`}>
      <text
        fg={palette.text}
        attributes={TextAttributes.DIM}
        width={labelWidth}
        height={1}
        flexShrink={0}
      >
        {fact.label}
      </text>
      <text fg={palette.text} wrapMode="none" truncate height={1} flexShrink={1}>
        {singleLine(fact.value)}
      </text>
    </box>
  ));
};

const PaneContent = (props: {
  row: ListRow | undefined;
  errors: readonly TicketFileError[];
  palette: Palette;
  detailWindow: DetailWindow | undefined;
}): ReactNode => {
  const { row, palette, detailWindow } = props;

  if (row === undefined) {
    return null;
  }

  if (detailWindow === undefined) {
    return <FactRows row={row} errors={props.errors} palette={palette} />;
  }

  return (
    <>
      <DetailHeader lines={detailWindow.header} palette={palette} />
      <AttentionBlock lines={detailWindow.attention} palette={palette} />
      <DetailTabs labels={detailWindow.tabs} body={detailWindow.body} palette={palette} />
    </>
  );
};

export const DetailPane = (props: {
  row: ListRow | undefined;
  errors: readonly TicketFileError[];
  palette: Palette;
  width: number;
  detailWindow: DetailWindow | undefined;
}): ReactNode => {
  const { palette } = props;

  return (
    <box
      flexDirection="column"
      width={props.width}
      flexShrink={0}
      overflow="hidden"
      paddingLeft={1}
      border={['left']}
      borderColor={palette.text}
    >
      <PaneContent
        row={props.row}
        errors={props.errors}
        palette={palette}
        detailWindow={props.detailWindow}
      />
    </box>
  );
};
