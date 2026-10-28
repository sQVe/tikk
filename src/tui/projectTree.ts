import type { NeedView, ProjectTree, TreeProject, TreeSlice, TreeStateName } from '../cli/cli.ts';
import { singleLine } from './rowList.tsx';
import type { DetailFact, ListRow } from './rowList.tsx';
import type { IconKind } from './ticketIcons.ts';

export interface FoldState {
  folded: ReadonlySet<string>;
  seen: ReadonlySet<string>;
}

export type FoldIntent = 'toggle' | 'open' | 'close';

interface TreeNode {
  key: string;
  id: string | null;
  kind: IconKind;
  state: TreeStateName | null;
  text: string;
  facts: DetailFact[];
  attention: number;
  foldedAtFirst: boolean;
  children: TreeNode[];
}

interface TicketEntry {
  id: string;
  title: string;
  state: TreeStateName;
}

type NeedCounts = ReadonlyMap<string, number>;

const kindLabels: Record<IconKind, string> = {
  project: 'Project',
  inbox: 'Inbox',
  plan: 'Plan',
  slice: 'Slice',
  task: 'Task',
  instructions: 'Instructions',
  instruction: 'Instruction',
};

export const noFolds: FoldState = { folded: new Set(), seen: new Set() };

const groupNode = (
  fields: Pick<TreeNode, 'key' | 'kind' | 'text' | 'facts' | 'foldedAtFirst' | 'children'>,
): TreeNode => ({ ...fields, id: null, state: null, attention: 0 });

const ticketNode = (
  kind: IconKind,
  entry: TicketEntry,
  children: TreeNode[] = [],
  extraFacts: DetailFact[] = [],
): TreeNode => ({
  key: entry.id,
  id: entry.id,
  kind,
  state: entry.state,
  text: `${entry.id}  ${singleLine(entry.title)}`,
  facts: [
    { label: 'ID', value: entry.id },
    { label: 'Title', value: singleLine(entry.title) },
    { label: 'Kind', value: kindLabels[kind] },
    { label: 'State', value: entry.state },
    ...extraFacts,
  ],
  attention: 0,
  foldedAtFirst: false,
  children,
});

const taskNodes = (tasks: readonly TicketEntry[]): TreeNode[] =>
  tasks.map((task) => ticketNode('task', task));

const instructionsNode = (slice: TreeSlice, needCounts: NeedCounts): TreeNode[] => {
  const { instructions } = slice;

  if (instructions.length === 0) {
    return [];
  }

  const attention = instructions.reduce(
    (total, instruction) => total + (needCounts.get(instruction.id) ?? 0),
    0,
  );

  const node = groupNode({
    key: `instructions:${slice.id}`,
    kind: 'instructions',
    text: `Instructions (${instructions.length})`,
    facts: [
      { label: 'Slice', value: slice.id },
      { label: 'Count', value: String(instructions.length) },
      { label: 'Needs', value: String(attention) },
    ],
    foldedAtFirst: true,
    children: instructions.map((instruction) => ticketNode('instruction', instruction)),
  });

  return [{ ...node, attention }];
};

const sliceNode = (slice: TreeSlice, needCounts: NeedCounts): TreeNode => {
  const pr = slice.pr === null ? [] : [{ label: 'PR', value: `#${slice.pr}` }];
  const children = [...taskNodes(slice.tasks), ...instructionsNode(slice, needCounts)];
  const node = ticketNode('slice', slice, children, pr);

  return slice.pr === null ? node : { ...node, text: `${node.text}  #${slice.pr}` };
};

const projectNode = (project: TreeProject, current: boolean, needCounts: NeedCounts): TreeNode => {
  const inbox = groupNode({
    key: `inbox:${project.name}`,
    kind: 'inbox',
    text: `Inbox (${project.inbox.length})`,
    facts: [
      { label: 'Project', value: project.name },
      { label: 'Count', value: String(project.inbox.length) },
    ],
    foldedAtFirst: false,
    children: taskNodes(project.inbox),
  });

  const plans = project.plans.map((plan) =>
    ticketNode('plan', plan, [
      ...taskNodes(plan.tasks),
      ...plan.slices.map((slice) => sliceNode(slice, needCounts)),
    ]),
  );

  const slices = project.slices.map((slice) => sliceNode(slice, needCounts));

  return groupNode({
    key: `project:${project.name}`,
    kind: 'project',
    text: project.name,
    facts: [{ label: 'Project', value: project.name }],
    foldedAtFirst: !current,
    children: [inbox, ...plans, ...slices],
  });
};

const needCountsOf = (needs: readonly NeedView[]): NeedCounts => {
  const counts = new Map<string, number>();

  for (const need of needs) {
    counts.set(need.id, (counts.get(need.id) ?? 0) + 1);
  }

  return counts;
};

const nodesOf = (tree: ProjectTree, needs: readonly NeedView[]): TreeNode[] => {
  const needCounts = needCountsOf(needs);

  return tree.projects.map((project) =>
    projectNode(project, project.name === tree.current, needCounts),
  );
};

const allNodes = (nodes: readonly TreeNode[]): TreeNode[] =>
  nodes.flatMap((node) => [node, ...allNodes(node.children)]);

// A node folds by default only the first time it shows, so a reload keeps the folds the user made.
export const foldsAfterLoad = (folds: FoldState, tree: ProjectTree): FoldState => {
  const added = allNodes(nodesOf(tree, [])).filter((node) => !folds.seen.has(node.key));

  if (added.length === 0) {
    return folds;
  }

  const firstFolded = added.filter((node) => node.foldedAtFirst).map((node) => node.key);

  return {
    folded: new Set([...folds.folded, ...firstFolded]),
    seen: new Set([...folds.seen, ...added.map((node) => node.key)]),
  };
};

const rowsOfNodes = (nodes: readonly TreeNode[], folds: FoldState, depth: number): ListRow[] =>
  nodes.flatMap((node) => {
    const folded = folds.folded.has(node.key);
    const hasChildren = node.children.length > 0;
    const unfoldedMark = hasChildren ? 'unfolded' : null;

    const row: ListRow = {
      key: node.key,
      id: node.id,
      text: node.text,
      facts: node.facts,
      marks: {
        depth,
        kind: node.kind,
        state: node.state,
        fold: hasChildren && folded ? 'folded' : unfoldedMark,
        attention: node.attention,
      },
    };

    const children = hasChildren && !folded ? rowsOfNodes(node.children, folds, depth + 1) : [];

    return [row, ...children];
  });

export const projectRowsOf = (
  tree: ProjectTree,
  folds: FoldState,
  needs: readonly NeedView[],
): ListRow[] => rowsOfNodes(nodesOf(tree, needs), folds, 0);

const foldsWith = (folds: FoldState, key: string, folded: boolean): FoldState => {
  const next = new Set(folds.folded);

  if (folded) {
    next.add(key);
  } else {
    next.delete(key);
  }

  return { ...folds, folded: next };
};

export const foldsAfter = (
  folds: FoldState,
  intent: FoldIntent,
  row: ListRow | undefined,
): FoldState => {
  const fold = row?.marks?.fold ?? null;

  if (row === undefined || fold === null) {
    return folds;
  }

  if (intent === 'toggle') {
    return foldsWith(folds, row.key, fold === 'unfolded');
  }

  return foldsWith(folds, row.key, intent === 'close');
};
