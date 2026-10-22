export type ViewIntent = 'quit' | 'moveUp' | 'moveDown' | 'switchView';

interface ViewCommand {
  intent: ViewIntent;
  keys: readonly string[];
}

export const viewCommands: readonly ViewCommand[] = [
  { intent: 'quit', keys: ['q', 'ctrl+c'] },
  { intent: 'moveUp', keys: ['up', 'k'] },
  { intent: 'moveDown', keys: ['down', 'j'] },
  { intent: 'switchView', keys: ['tab'] },
];
