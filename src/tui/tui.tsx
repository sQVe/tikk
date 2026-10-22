import type { CommandContext } from '@opentui/keymap';
import type { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { KeymapProvider, useBindings } from '@opentui/keymap/react';
import { useTerminalDimensions } from '@opentui/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { CliFailure, NeedsReading, TreeGroup } from '../cli/cli.ts';
import type { Result } from '../result.ts';
import { HomeView, singleLine } from './homeView.tsx';
import { TreeView, treeRowsOf } from './treeView.tsx';
import type { TreeRow } from './treeView.tsx';
import { viewCommands } from './viewKeymap.ts';
import type { ViewIntent } from './viewKeymap.ts';

interface TuiEffects {
  load: () => Promise<Result<NeedsReading, CliFailure>>;
  loadTree: () => Promise<Result<TreeGroup[], CliFailure>>;
  edit: (rawId: string) => Promise<Result<undefined, CliFailure>>;
  // Suspends the TUI while run uses the terminal.
  lend: <Value>(run: () => Promise<Value>) => Promise<Value>;
  // Calls listener when the store changes, and returns the function that unsubscribes it.
  onChange: (listener: () => void) => () => void;
}

export interface AppProps {
  effects: TuiEffects;
  keymap: ReturnType<typeof createDefaultOpenTuiKeymap>;
  onQuit: () => void;
}

type Loaded<Value> =
  | { state: 'loading' }
  | { state: 'failed'; message: string }
  | { state: 'loaded'; value: Value };

type ViewName = 'home' | 'tree';

interface Row {
  key: string;
  id: string | null;
}

interface Selection {
  index: number;
  key: string | undefined;
}

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

// Each change starts a new load. The session runs loads in order, so the last result is the newest.
const useLoaded = <Value,>(
  enabled: boolean,
  load: () => Promise<Result<Value, CliFailure>>,
  generation: number,
): Loaded<Value> => {
  const [loaded, setLoaded] = useState<Loaded<Value>>({ state: 'loading' });

  useEffect(() => {
    if (!enabled) {
      return;
    }

    load()
      .then((result) => {
        setLoaded(
          result.ok
            ? { state: 'loaded', value: result.value }
            : { state: 'failed', message: result.reason.message },
        );
      })
      .catch((error: unknown) => {
        setLoaded({ state: 'failed', message: errorMessage(error, 'The list did not load.') });
      });
  }, [enabled, load, generation]);

  return loaded;
};

const useGeneration = (onChange: TuiEffects['onChange']): number => {
  const [generation, setGeneration] = useState(0);

  useEffect(
    () =>
      onChange(() => {
        setGeneration((current) => current + 1);
      }),
    [onChange],
  );

  return generation;
};

const failureStatus = (loaded: Loaded<unknown>): string => {
  if (loaded.state === 'loading') {
    return 'Loading...';
  }

  return loaded.state === 'failed' ? loaded.message : '';
};

const homeStatusOf = (loaded: Loaded<NeedsReading>): string => {
  if (loaded.state !== 'loaded') {
    return failureStatus(loaded);
  }

  return loaded.value.reconcileProblems.map((problem) => problem.message).join('; ');
};

const homeRowsOf = (loaded: Loaded<NeedsReading>): Row[] =>
  loaded.state === 'loaded'
    ? loaded.value.items.map((item) => ({ key: `${item.id}:${item.reason}`, id: item.id }))
    : [];

const treeRowsOfLoaded = (loaded: Loaded<TreeGroup[]>): TreeRow[] =>
  loaded.state === 'loaded' ? treeRowsOf(loaded.value) : [];

const clampedIndex = (index: number, count: number): number =>
  Math.max(0, Math.min(count - 1, index));

// The selected row stays selected after a reload while it exists. Otherwise the index stays.
const resolvedSelection = (selection: Selection, rows: readonly Row[]): Selection => {
  const found = rows.findIndex((row) => row.key === selection.key);
  const index = found === -1 ? clampedIndex(selection.index, rows.length) : found;

  return { index, key: rows[index]?.key };
};

const sameSelection = (first: Selection, second: Selection): boolean =>
  first.index === second.index && first.key === second.key;

// Stores the selection as shown, so the next reload starts from the row the user sees.
const useResolvedSelection = (rowsByView: Record<ViewName, readonly Row[]>) => {
  const [selection, setSelection] = useState<Record<ViewName, Selection>>({
    home: { index: 0, key: undefined },
    tree: { index: 0, key: undefined },
  });

  const resolved = {
    home: resolvedSelection(selection.home, rowsByView.home),
    tree: resolvedSelection(selection.tree, rowsByView.tree),
  };

  const homeChanged = !sameSelection(resolved.home, selection.home);
  const treeChanged = !sameSelection(resolved.tree, selection.tree);

  // A key can change the selection before this effect runs, and that change wins.
  useEffect(() => {
    if (homeChanged || treeChanged) {
      setSelection((current) => (current === selection ? resolved : current));
    }
  });

  return [resolved, setSelection] as const;
};

const Screen = ({ effects, onQuit }: Omit<AppProps, 'keymap'>): ReactNode => {
  const [view, setView] = useState<ViewName>('home');

  const [treeRequested, setTreeRequested] = useState(false);
  const [notice, setNotice] = useState('');
  const { height } = useTerminalDimensions();
  const generation = useGeneration(effects.onChange);
  const home = useLoaded(true, effects.load, generation);
  const tree = useLoaded(treeRequested, effects.loadTree, generation);
  const treeRows = treeRowsOfLoaded(tree);
  const homeRows = homeRowsOf(home);
  const [selection, setSelection] = useResolvedSelection({ home: homeRows, tree: treeRows });
  const rows = view === 'home' ? homeRows : treeRows;
  const selected = selection[view].index;

  const move = (step: number) => {
    const index = clampedIndex(selected + step, rows.length);

    setSelection((current) => ({ ...current, [view]: { index, key: rows[index]?.key } }));
  };

  const edit = (id: string) => {
    effects
      .lend(() => effects.edit(id))
      .then((result) => {
        setNotice(result.ok ? '' : result.reason.message);
      })
      .catch((error: unknown) => {
        setNotice(errorMessage(error, 'The editor did not run.'));
      });
  };

  const run = (intent: ViewIntent) => {
    if (intent === 'quit') {
      onQuit();
    }

    if (intent === 'switchView') {
      setView(view === 'home' ? 'tree' : 'home');
      setTreeRequested(true);
    }

    if (intent === 'moveUp') {
      move(-1);
    }

    if (intent === 'moveDown') {
      move(1);
    }

    const id = rows[selected]?.id;

    if (intent === 'edit' && typeof id === 'string') {
      edit(id);
    }
  };

  // The keymap swaps bindings only in a passive effect, so the bindings stay fixed and read the
  // rows on screen from a ref that every commit updates first.
  const latestRun = useRef(run);

  useLayoutEffect(() => {
    latestRun.current = run;
  });

  useBindings(
    () => ({
      bindings: viewCommands.flatMap((command) =>
        command.keys.map((key) => ({
          key,
          cmd: (context: CommandContext) => {
            context.event.preventDefault();
            latestRun.current(command.intent);
          },
        })),
      ),
    }),
    [],
  );

  const listHeight = Math.max(1, height - 1);
  const viewStatus = view === 'home' ? homeStatusOf(home) : failureStatus(tree);
  const status = notice === '' ? viewStatus : notice;

  return (
    <box flexDirection="column" flexGrow={1}>
      {view === 'home' && home.state === 'loaded' ? (
        <HomeView items={home.value.items} selected={selected} height={listHeight} />
      ) : null}
      {view === 'tree' && tree.state === 'loaded' ? (
        <TreeView rows={treeRows} selected={selected} height={listHeight} />
      ) : null}
      <text wrapMode="none" truncate height={1}>
        {singleLine(status)}
      </text>
    </box>
  );
};

export const App = ({ effects, keymap, onQuit }: AppProps): ReactNode => (
  <KeymapProvider keymap={keymap}>
    <Screen effects={effects} onQuit={onQuit} />
  </KeymapProvider>
);
