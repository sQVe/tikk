import { TextAttributes } from '@opentui/core';
import type { ReactNode } from 'react';

import type { MessageWindow } from './messageWindow.ts';
import type { Palette } from './palette.ts';

export const MessageOverlay = (props: {
  messageWindow: MessageWindow;
  palette: Palette;
  height: number;
  top: number;
}): ReactNode => {
  const { palette } = props;

  const { rows, viewportRows, maximumTop, overflows } = props.messageWindow;

  const top = Math.min(props.top, maximumTop);
  const visible = rows.slice(top, top + viewportRows);
  const position = `${top + 1}-${top + visible.length} of ${rows.length}`;

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      right={0}
      height={props.height}
      border
      borderStyle="rounded"
      borderColor={palette.key}
      title=" Messages "
      backgroundColor={palette.overlayBackground}
      zIndex={10}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      {visible.length === 0 ? (
        <text fg={palette.text} attributes={TextAttributes.DIM}>
          No messages yet
        </text>
      ) : null}
      {visible.map((row) => (
        <text key={row.key} fg={palette.text} wrapMode="none">
          {row.text}
        </text>
      ))}
      {overflows ? (
        <text fg={palette.text} attributes={TextAttributes.DIM}>
          {position}
        </text>
      ) : null}
    </box>
  );
};
