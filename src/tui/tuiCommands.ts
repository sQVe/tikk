import type { OverlayMove } from './overlayScroll.ts';
import type { TuiIntent, TuiSnapshot } from './tuiSession.ts';

type CommandIntent =
  | { kind: 'session'; intent: TuiIntent }
  | { kind: 'scrollOverlay'; move: OverlayMove }
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
  // Keys that still run this command while a key sequence is pending, instead of ending it as a
  // miss.
  keysDuringSequence?: readonly string[];
  // The help and messages layers also bind this command's keys, and run this move on the open
  // overlay.
  overlayMove?: OverlayMove;
  disabledReason: (snapshot: TuiSnapshot) => string | undefined;
  intent: CommandIntent;
}

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

const isOverlayScope = (scope: CommandScope): scope is OverlayScope =>
  scope === 'help' || scope === 'messages';

const scrollCopyOf = (command: Command, scope: OverlayScope, move: OverlayMove): Command => ({
  ...command,
  scope,
  disabledReason: () => undefined,
  intent: { kind: 'scrollOverlay', move },
});

export const commandsOfLayer = (commands: readonly Command[], scope: CommandScope): Command[] => {
  const own = commands.filter((command) => command.scope === scope);
  const copies: Command[] = [];

  if (isOverlayScope(scope)) {
    for (const command of commands) {
      if (command.overlayMove !== undefined) {
        copies.push(scrollCopyOf(command, scope, command.overlayMove));
      }
    }
  }

  return [...own, ...copies];
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

export const keyNamesOf = (commands: readonly Command[], id: string): string[] => {
  const keys = commands.find((command) => command.id === id)?.keys ?? [];

  return keys.map((key) => readableKeyOf(key));
};
