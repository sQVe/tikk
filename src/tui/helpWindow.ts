import { fitText } from './textLayout.ts';
import { catalog, helpSections, keysOfAction } from './tuiCommands.ts';
import type { BindingTable, Command } from './tuiCommands.ts';
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

const keysTextOf = (bindings: BindingTable, command: Command): string =>
  keysOfAction(bindings, command.scope, command.id).join('/');

const rowOf = (bindings: BindingTable, command: Command, innerWidth: number): HelpLine => {
  const keys = fitText(keysTextOf(bindings, command), innerWidth);
  const labelWidth = keys === '' ? innerWidth : innerWidth - keys.length - 1;

  return { kind: 'row', keys, label: fitText(command.label, labelWidth) };
};

const commandLinesOf = (
  bindings: BindingTable,
  command: Command,
  snapshot: TuiSnapshot,
  innerWidth: number,
): HelpLine[] => {
  const reason = command.disabledReason(snapshot);
  const row = rowOf(bindings, command, innerWidth);

  if (reason === undefined) {
    return [row];
  }

  return [row, { kind: 'reason', text: fitText(`${reasonIndent}${reason}`, innerWidth) }];
};

const linesOf = (bindings: BindingTable, snapshot: TuiSnapshot, innerWidth: number): HelpLine[] => {
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
      lines.push(...commandLinesOf(bindings, command, snapshot, innerWidth));
    }
  }

  return lines;
};

export const footerOf = (bindings: BindingTable, position: string, innerWidth: number): string => {
  const scrollKeys = [
    ...keysOfAction(bindings, 'help', 'selectNext').slice(0, 1),
    ...keysOfAction(bindings, 'help', 'selectPrevious').slice(0, 1),
  ];

  const closeKey = keysOfAction(bindings, 'help', 'closeHelp')[0];
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
  bindings: BindingTable,
  snapshot: TuiSnapshot,
  height: number,
  width: number,
): HelpWindow => {
  const boxWidth = Math.max(minimumBoxWidth, Math.min(width - terminalMargin, maximumBoxWidth));
  const lines = linesOf(bindings, snapshot, boxWidth - boxChromeColumns);
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
