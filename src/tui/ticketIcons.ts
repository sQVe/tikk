import type { TreeStateName } from '../cli/cli.ts';

export type IconChoice = 'unicode' | 'nerdFont';

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

const unicodeIcons: IconSet = {
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

const nerdFontIcons: IconSet = {
  kinds: {
    project: '\uf1b2',
    inbox: '\uf01c',
    plan: '\uf279',
    slice: '\uf0e8',
    task: '\uf0ae',
    instructions: '\uf15c',
    instruction: '\uf105',
  },
  states: {
    draft: '\uf1db',
    open: '\uf10c',
    planned: '\uf10c',
    active: '\uf042',
    submitted: '\uf192',
    inReview: '\uf192',
    mergedUnverified: '\uf14a',
    flagged: '\uf05e',
    done: '\uf058',
    canceled: '\uf057',
  },
  folds: { folded: '\uf054', unfolded: '\uf078' },
  attention: '\uf06a',
};

export const iconSets: Readonly<Record<IconChoice, IconSet>> = {
  unicode: unicodeIcons,
  nerdFont: nerdFontIcons,
};
