import { detailOf } from './detailState.ts';
import type { DetailStep } from './detailState.ts';
import type { OverlayMove } from './overlayScroll.ts';
import type { TuiIntent, TuiSnapshot } from './tuiSession.ts';

type CommandIntent =
  | { kind: 'session'; intent: TuiIntent }
  | { kind: 'scrollDetail'; step: DetailStep }
  | { kind: 'quit' };

export type CommandScope =
  | 'global'
  | 'list'
  | 'detail'
  | 'input'
  | 'rank'
  | 'visual'
  | 'help'
  | 'messages';

type OverlayScope = Extract<CommandScope, 'help' | 'messages'>;

type HelpSection = 'app' | 'moving' | 'tickets' | 'overlays';

export interface Command {
  // Remaps name a command by this id, so it must not change.
  id: string;
  label: string;
  scope: CommandScope;
  section: HelpSection;
  hiddenFromHelp?: true;
  keys: readonly string[];
  keysDuringSequence?: readonly string[];
  overlayMove?: OverlayMove;
  disabledReason: (snapshot: TuiSnapshot) => string | undefined;
  intent: CommandIntent;
}

export interface Binding {
  command: Command;
  scope: CommandScope;
  key: string;
  user: boolean;
  duringSequence: boolean;
  overlayMove?: OverlayMove;
}

export interface KeyChoice {
  key: string;
  user: boolean;
  sequenceExit: boolean;
}

type KeyChoices = (command: Command) => readonly KeyChoice[];

export type BindingTable = Readonly<Record<CommandScope, readonly Binding[]>>;

type PaneCommand = Omit<Command, 'scope' | 'hiddenFromHelp'>;

export const commandScopes: readonly CommandScope[] = [
  'global',
  'list',
  'detail',
  'input',
  'rank',
  'visual',
  'help',
  'messages',
];

const overlayScopes: readonly OverlayScope[] = ['help', 'messages'];

export const helpSections: readonly HelpSection[] = ['app', 'moving', 'tickets', 'overlays'];

export const scopePriority: Record<CommandScope, number> = {
  help: 50,
  messages: 50,
  input: 40,
  rank: 30,
  visual: 30,
  detail: 25,
  list: 20,
  global: 10,
};

const enabled = (): undefined => undefined;

const selectedRowReason = (snapshot: TuiSnapshot): string | undefined =>
  snapshot.views[snapshot.view].rows.length === 0 ? 'No row is selected.' : undefined;

const selectedTicketReason = (snapshot: TuiSnapshot): string | undefined => {
  const { id } = snapshot.views[snapshot.view].selection;

  if (id === null) {
    return 'This row has no ticket.';
  }

  return id === undefined ? 'No ticket is selected.' : undefined;
};

const foldReason = (snapshot: TuiSnapshot): string | undefined => {
  const view = snapshot.views[snapshot.view];
  const fold = view.rows[view.selection.index]?.marks?.fold ?? null;

  return fold === null ? 'This row does not fold.' : undefined;
};

const planReason = (snapshot: TuiSnapshot): string | undefined => {
  const ticketReason = selectedTicketReason(snapshot);

  if (ticketReason !== undefined) {
    return ticketReason;
  }

  const detail = detailOf(snapshot.detail.load);

  if (detail === undefined) {
    return snapshot.detail.load.status === 'failed'
      ? 'The ticket did not load, so its kind is unknown.'
      : 'The ticket is still loading.';
  }

  return detail.ticket.kind === 'plan' ? undefined : 'The selected row is not a plan.';
};

const session = (intent: TuiIntent): CommandIntent => ({ kind: 'session', intent });

const paneCommands: readonly PaneCommand[] = [
  {
    id: 'previousTab',
    label: 'Show the previous detail tab',
    section: 'tickets',
    keys: ['['],
    disabledReason: enabled,
    intent: session({ kind: 'previousTab' }),
  },
  {
    id: 'nextTab',
    label: 'Show the next detail tab',
    section: 'tickets',
    keys: [']'],
    disabledReason: enabled,
    intent: session({ kind: 'nextTab' }),
  },
  {
    id: 'toggleAttention',
    label: 'Expand or shrink what needs you',
    section: 'tickets',
    keys: ['x'],
    disabledReason: enabled,
    intent: session({ kind: 'toggleAttention' }),
  },
  {
    id: 'editDesign',
    label: 'Edit the plan design.md in $EDITOR',
    section: 'tickets',
    keys: ['shift+d'],
    disabledReason: planReason,
    intent: session({ kind: 'editDesign' }),
  },
  {
    id: 'scrollDetailHalfDown',
    label: 'Scroll the detail down half a page',
    section: 'moving',
    keys: ['ctrl+d'],
    disabledReason: enabled,
    intent: { kind: 'scrollDetail', step: { unit: 'halfPage', direction: 1 } },
  },
  {
    id: 'scrollDetailHalfUp',
    label: 'Scroll the detail up half a page',
    section: 'moving',
    keys: ['ctrl+u'],
    disabledReason: enabled,
    intent: { kind: 'scrollDetail', step: { unit: 'halfPage', direction: -1 } },
  },
];

// The panel shows beside the list or full-screen, so its commands work in both scopes. Help lists
// each once.
const paneCommandsIn = (scope: CommandScope): Command[] =>
  paneCommands.map((command) =>
    Object.assign({ scope }, command, scope === 'list' ? {} : { hiddenFromHelp: true as const }),
  );

export const catalog: readonly Command[] = [
  {
    id: 'quit',
    label: 'Quit',
    scope: 'global',
    section: 'app',
    keys: ['q', 'ctrl+c'],
    keysDuringSequence: ['ctrl+c'],
    disabledReason: enabled,
    intent: { kind: 'quit' },
  },
  {
    id: 'help',
    label: 'Toggle help',
    scope: 'global',
    section: 'app',
    keys: ['?'],
    disabledReason: enabled,
    intent: session({ kind: 'toggleHelp' }),
  },
  {
    id: 'showMessages',
    label: 'Show recent messages',
    scope: 'global',
    section: 'app',
    keys: ['gm'],
    disabledReason: enabled,
    intent: session({ kind: 'openMessages' }),
  },
  {
    id: 'selectNext',
    label: 'Select next row',
    scope: 'list',
    section: 'moving',
    keys: ['j', 'down'],
    overlayMove: { kind: 'lines', lines: 1 },
    disabledReason: enabled,
    intent: session({ kind: 'moveDown' }),
  },
  {
    id: 'selectPrevious',
    label: 'Select previous row',
    scope: 'list',
    section: 'moving',
    keys: ['k', 'up'],
    overlayMove: { kind: 'lines', lines: -1 },
    disabledReason: enabled,
    intent: session({ kind: 'moveUp' }),
  },
  {
    id: 'selectFirst',
    label: 'Select first row',
    scope: 'list',
    section: 'moving',
    keys: ['gg'],
    overlayMove: { kind: 'edge', edge: 'top' },
    disabledReason: enabled,
    intent: session({ kind: 'moveFirst' }),
  },
  {
    id: 'selectLast',
    label: 'Select last row',
    scope: 'list',
    section: 'moving',
    keys: ['shift+g'],
    overlayMove: { kind: 'edge', edge: 'bottom' },
    disabledReason: enabled,
    intent: session({ kind: 'moveLast' }),
  },
  {
    id: 'toggleFold',
    label: 'Fold or unfold the selected row',
    scope: 'list',
    section: 'moving',
    keys: ['za', 'space'],
    disabledReason: foldReason,
    intent: session({ kind: 'fold', fold: 'toggle' }),
  },
  {
    id: 'openFold',
    label: 'Unfold the selected row',
    scope: 'list',
    section: 'moving',
    keys: ['zo'],
    disabledReason: foldReason,
    intent: session({ kind: 'fold', fold: 'open' }),
  },
  {
    id: 'closeFold',
    label: 'Fold the selected row',
    scope: 'list',
    section: 'moving',
    keys: ['zc'],
    disabledReason: foldReason,
    intent: session({ kind: 'fold', fold: 'close' }),
  },
  {
    id: 'switchView',
    label: 'Switch between home and projects',
    scope: 'list',
    section: 'tickets',
    keys: ['s'],
    disabledReason: enabled,
    intent: session({ kind: 'switchView' }),
  },
  {
    id: 'edit',
    label: 'Edit the ticket in $EDITOR',
    scope: 'list',
    section: 'tickets',
    keys: ['e'],
    disabledReason: selectedTicketReason,
    intent: session({ kind: 'edit' }),
  },
  {
    id: 'openDetail',
    label: 'Show the selected row in detail',
    scope: 'list',
    section: 'tickets',
    keys: ['return'],
    disabledReason: selectedRowReason,
    intent: session({ kind: 'openDetail' }),
  },
  ...paneCommandsIn('list'),
  ...paneCommandsIn('detail'),
  {
    id: 'scrollDetailDown',
    label: 'Scroll the full-screen detail down',
    scope: 'detail',
    section: 'moving',
    keys: ['j', 'down'],
    disabledReason: enabled,
    intent: { kind: 'scrollDetail', step: { unit: 'line', direction: 1 } },
  },
  {
    id: 'scrollDetailUp',
    label: 'Scroll the full-screen detail up',
    scope: 'detail',
    section: 'moving',
    keys: ['k', 'up'],
    disabledReason: enabled,
    intent: { kind: 'scrollDetail', step: { unit: 'line', direction: -1 } },
  },
  {
    id: 'closeDetail',
    label: 'Close the detail',
    scope: 'detail',
    section: 'overlays',
    keys: ['escape'],
    disabledReason: enabled,
    intent: session({ kind: 'closeDetail' }),
  },
  {
    id: 'closeHelp',
    label: 'Close help',
    scope: 'help',
    section: 'overlays',
    keys: ['q', 'escape'],
    keysDuringSequence: ['q', 'escape'],
    disabledReason: enabled,
    intent: session({ kind: 'closeOverlay' }),
  },
  {
    id: 'closeMessages',
    label: 'Close messages',
    scope: 'messages',
    section: 'overlays',
    keys: ['q', 'escape'],
    keysDuringSequence: ['q', 'escape'],
    disabledReason: enabled,
    intent: session({ kind: 'closeOverlay' }),
  },
];

export const emptyBindingTable = (): Record<CommandScope, Binding[]> => ({
  global: [],
  list: [],
  detail: [],
  input: [],
  rank: [],
  visual: [],
  help: [],
  messages: [],
});

const bindingOf = (
  command: Command,
  scope: CommandScope,
  choice: KeyChoice,
  overlayMove: OverlayMove | undefined,
): Binding => ({
  command,
  scope,
  key: choice.key,
  user: choice.user,
  duringSequence: choice.sequenceExit,
  ...(overlayMove === undefined ? {} : { overlayMove }),
});

export const defaultChoiceOf = (command: Command, key: string): KeyChoice => ({
  key,
  user: false,
  sequenceExit: command.keysDuringSequence?.includes(key) === true,
});

const defaultChoicesOf: KeyChoices = (command) =>
  command.keys.map((key) => defaultChoiceOf(command, key));

export const expandBindings = (choicesOf: KeyChoices): BindingTable => {
  const planned = catalog.map((command) => ({ command, choices: choicesOf(command) }));
  const table = emptyBindingTable();

  for (const { command, choices } of planned) {
    for (const choice of choices) {
      table[command.scope].push(bindingOf(command, command.scope, choice, undefined));
    }
  }

  for (const { command, choices } of planned) {
    const { overlayMove } = command;

    if (overlayMove === undefined) {
      continue;
    }

    for (const scope of overlayScopes) {
      for (const choice of choices) {
        table[scope].push(bindingOf(command, scope, choice, overlayMove));
      }
    }
  }

  return table;
};

export const defaultBindings: BindingTable = expandBindings(defaultChoicesOf);

const readableKeyNames = new Map(
  Object.entries({
    escape: 'Esc',
    return: 'Enter',
    space: 'Space',
    tab: 'Tab',
    up: '↑',
    down: '↓',
  }),
);

const shiftedLetter = /^shift\+([a-z])$/;
const controlKey = /^ctrl\+(.+)$/;

export const readableKeyOf = (key: string): string => {
  const letter = shiftedLetter.exec(key)?.[1];

  if (letter !== undefined) {
    return letter.toUpperCase();
  }

  const controlled = controlKey.exec(key)?.[1];

  if (controlled !== undefined) {
    return `Ctrl+${controlled.toUpperCase()}`;
  }

  return readableKeyNames.get(key) ?? key;
};

export const keysOfAction = (bindings: BindingTable, scope: CommandScope, id: string): string[] =>
  bindings[scope]
    .filter((binding) => binding.command.id === id)
    .map((binding) => readableKeyOf(binding.key));
