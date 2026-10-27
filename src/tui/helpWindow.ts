import { fitText } from './textLayout.ts';
import { commandsOfLayer, helpSections, keyNamesOf, readableKeyOf } from './tuiCommands.ts';
import type { Command } from './tuiCommands.ts';
import type { TuiSnapshot } from './tuiSession.ts';

export type HelpLine =
  | { kind: 'heading'; text: string }
  | { kind: 'row'; keys: string; label: string }
  | { kind: 'reason'; text: string };

export interface HelpWindow {
  lines: readonly HelpLine[];
  viewportRows: number;
  maximumTop: number;
  overflows: boolean;
  boxWidth: number;
  boxHeight: number;
}

const borderRows = 2;
const footerRows = 1;
const statusRows = 1;
const reasonIndent = '  ';

export const boxChromeColumns = 4;
const minimumBoxWidth = 20;
const maximumBoxWidth = 64;
const terminalMargin = 4;

const sectionTitles: Record<Command['section'], string> = {
  app: 'App',
  moving: 'Moving',
  tickets: 'Tickets',
  overlays: 'Overlays',
};

const keysTextOf = (command: Command): string =>
  command.keys.map((key) => readableKeyOf(key)).join('/');

const rowOf = (command: Command, innerWidth: number): HelpLine => {
  const keys = fitText(keysTextOf(command), innerWidth);
  const labelWidth = keys === '' ? innerWidth : innerWidth - keys.length - 1;

  return { kind: 'row', keys, label: fitText(command.label, labelWidth) };
};

const commandLinesOf = (
  command: Command,
  snapshot: TuiSnapshot,
  innerWidth: number,
): HelpLine[] => {
  const reason = command.disabledReason(snapshot);
  const row = rowOf(command, innerWidth);

  if (reason === undefined) {
    return [row];
  }

  return [row, { kind: 'reason', text: fitText(`${reasonIndent}${reason}`, innerWidth) }];
};

const linesOf = (
  catalog: readonly Command[],
  snapshot: TuiSnapshot,
  innerWidth: number,
): HelpLine[] => {
  const listed = catalog.filter((command) => command.hiddenFromHelp !== true);
  const lines: HelpLine[] = [];

  for (const section of helpSections) {
    const commands = listed.filter((command) => command.section === section);

    if (commands.length === 0) {
      continue;
    }

    if (lines.length > 0) {
      lines.push({ kind: 'row', keys: '', label: '' });
    }

    lines.push({ kind: 'heading', text: fitText(sectionTitles[section], innerWidth) });

    for (const command of commands) {
      lines.push(...commandLinesOf(command, snapshot, innerWidth));
    }
  }

  return lines;
};

export const footerOf = (
  catalog: readonly Command[],
  position: string,
  innerWidth: number,
): string => {
  const helpCommands = commandsOfLayer(catalog, 'help');

  const scrollKeys = [
    ...keyNamesOf(helpCommands, 'selectNext').slice(0, 1),
    ...keyNamesOf(helpCommands, 'selectPrevious').slice(0, 1),
  ];

  const closeKey = keyNamesOf(helpCommands, 'closeHelp')[0];
  const parts = [position];

  if (scrollKeys.length > 0) {
    parts.push(`${scrollKeys.join('/')} scroll`);
  }

  if (closeKey !== undefined) {
    parts.push(`${closeKey} close`);
  }

  while (parts.length > 1 && parts.join('  ').length > innerWidth) {
    parts.pop();
  }

  return fitText(parts.join('  '), innerWidth);
};

export const helpWindowOf = (
  catalog: readonly Command[],
  snapshot: TuiSnapshot,
  height: number,
  width: number,
): HelpWindow => {
  const boxWidth = Math.max(minimumBoxWidth, Math.min(width - terminalMargin, maximumBoxWidth));
  const lines = linesOf(catalog, snapshot, boxWidth - boxChromeColumns);
  const availableRows = Math.max(1, height - statusRows - 1);
  const overflows = lines.length + borderRows > availableRows;

  const viewportRows = overflows
    ? Math.max(1, availableRows - borderRows - footerRows)
    : lines.length;

  const boxHeight = viewportRows + borderRows + (overflows ? footerRows : 0);

  return {
    lines,
    viewportRows,
    maximumTop: Math.max(0, lines.length - viewportRows),
    overflows,
    boxWidth,
    boxHeight,
  };
};
