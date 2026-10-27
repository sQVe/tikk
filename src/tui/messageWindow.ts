import { wrapCells } from './textLayout.ts';
import type { TuiMessage } from './tuiSession.ts';

interface MessageRow {
  key: string;
  text: string;
}

export interface MessageWindow {
  rows: readonly MessageRow[];
  viewportRows: number;
  maximumTop: number;
  overflows: boolean;
}

const borderRows = 2;
const footerRows = 1;
const boxChromeColumns = 4;

const lineBreak = /\r\n|\r|\n/;

const rowsOfMessage = (message: TuiMessage, columns: number): MessageRow[] =>
  message.text.split(lineBreak).flatMap((line, lineIndex) =>
    wrapCells(line, columns).map((text, index) => ({
      key: `${message.id}-${lineIndex}-${index}`,
      text,
    })),
  );

export const messageWindowOf = (
  messages: readonly TuiMessage[],
  width: number,
  height: number,
): MessageWindow => {
  const columns = Math.max(1, width - boxChromeColumns);
  const rows = messages.flatMap((message) => rowsOfMessage(message, columns));
  const availableRows = Math.max(1, height - borderRows);
  const overflows = rows.length > availableRows;
  const viewportRows = overflows ? Math.max(1, availableRows - footerRows) : availableRows;

  return { rows, viewportRows, maximumTop: Math.max(0, rows.length - viewportRows), overflows };
};
