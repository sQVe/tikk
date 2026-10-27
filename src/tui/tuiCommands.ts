import type { OverlayMove } from './overlayScroll.ts';
import type { TuiIntent, TuiSnapshot } from './tuiSession.ts';

type CommandIntent = { kind: 'session'; intent: TuiIntent } | { kind: 'quit' };

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
  // Default keys. A config remap replaces them in the binding table.
  keys: readonly string[];
  // Keys that still run this command while a key sequence is pending, instead of ending it as a
  // miss.
  keysDuringSequence?: readonly string[];
  // The help and messages layers also bind this command's keys, and run this move on the open
  // overlay.
  overlayMove?: OverlayMove;
  disabledReason: (snapshot: TuiSnapshot) => string | undefined;
  intent: CommandIntent;
}

// One key of one action in one scope. An overlay copy runs the action's movement on the open
// overlay instead of the action itself.
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
  // Whether a pending sequence hands this key to the command. A user key is one only when it is a
  // single stroke, since the matcher takes one stroke.
  sequenceExit: boolean;
}

type KeyChoices = (command: Command) => readonly KeyChoice[];

export type BindingTable = Readonly<Record<CommandScope, readonly Binding[]>>;

// Every scope in the order the layers are resolved.
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

// A higher number wins a key shared by active scopes, as the keymap sorts layers.
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

const session = (intent: TuiIntent): CommandIntent => ({ kind: 'session', intent });

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
    id: 'switchView',
    label: 'Switch between home and tree',
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

// Own bindings come before the overlay copies of a scope, so the first match is the own action.
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
