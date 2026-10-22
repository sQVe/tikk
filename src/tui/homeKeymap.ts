export type HomeIntent = 'quit' | 'moveUp' | 'moveDown';

interface HomeCommand {
  intent: HomeIntent;
  keys: readonly string[];
}

export const homeCommands: readonly HomeCommand[] = [
  { intent: 'quit', keys: ['q', 'ctrl+c'] },
  { intent: 'moveUp', keys: ['up', 'k'] },
  { intent: 'moveDown', keys: ['down', 'j'] },
];
