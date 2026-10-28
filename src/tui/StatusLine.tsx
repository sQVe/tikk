import type { ReactNode } from 'react';

import type { Palette } from './palette.ts';
import { singleLine } from './rowList.tsx';

export const StatusLine = (props: {
  view: string;
  text: string;
  helpKeys: string;
  palette: Palette;
}): ReactNode => (
  <box flexDirection="row" height={1} gap={2}>
    <text fg={props.palette.dim} flexShrink={0}>
      {props.view}
    </text>
    <text wrapMode="none" truncate flexShrink={1}>
      {singleLine(props.text)}
    </text>
    <box flexGrow={1} />
    <text fg={props.palette.dim} flexShrink={0}>
      {`${props.helpKeys} help`}
    </text>
  </box>
);
