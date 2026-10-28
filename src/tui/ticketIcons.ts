import type { TreeStateName } from '../cli/cli.ts';

export type IconKind =
  | 'project'
  | 'inbox'
  | 'plan'
  | 'slice'
  | 'task'
  | 'instructions'
  | 'instruction';

export type FoldMark = 'folded' | 'unfolded';

export interface IconSet {
  kinds: Readonly<Record<IconKind, string>>;
  states: Readonly<Record<TreeStateName, string>>;
  folds: Readonly<Record<FoldMark, string>>;
  attention: string;
}

export const unicodeIcons: IconSet = {
  kinds: {
    project: '■',
    inbox: '□',
    plan: '◆',
    slice: '◇',
    task: '•',
    instructions: '≡',
    instruction: '›',
  },
  states: {
    draft: '◌',
    open: '○',
    planned: '○',
    active: '◐',
    submitted: '◑',
    inReview: '◑',
    mergedUnverified: '◕',
    flagged: '⊘',
    done: '●',
    canceled: '×',
  },
  folds: { folded: '▸', unfolded: '▾' },
  attention: '!',
};
