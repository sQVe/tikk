import type { CommandContext } from '@opentui/keymap';
import type { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { KeymapProvider, useBindings } from '@opentui/keymap/react';
import { useTerminalDimensions } from '@opentui/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { CliFailure, NeedsReading, TreeGroup } from '../cli/cli.ts';
import type { Result } from '../result.ts';
import { homeRowsOf } from './homeView.tsx';
import { RowList, singleLine } from './rowList.tsx';
import type { ListRow } from './rowList.tsx';
import { treeRowsOf } from './treeView.tsx';
import { viewCommands } from './viewKeymap.ts';
import type { ViewIntent } from './viewKeymap.ts';

interface TuiEffects {
  load: () => Promise<Result<NeedsReading, CliFailure>>;
  loadTree: () => Promise<Result<TreeGroup[], CliFailure>>;
  edit: (rawId: string) => Promise<Result<undefined, CliFailure>>;
  lend: <Value>(run: () => Promise<Value>) => Promise<Result<Value, 'cancelled'>>;
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

interface Selection {
  index: number;
  key: string | undefined;
}

interface ListState<Value> {
  loaded: Loaded<Value>;
  rows: ListRow[];
  selection: Selection;
}

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const clampedIndex = (index: number, count: number): number =>
  Math.max(0, Math.min(count - 1, index));

const resolvedSelection = (selection: Selection, rows: readonly ListRow[]): Selection => {
  const found = rows.findIndex((row) => row.key === selection.key);
  const index = found === -1 ? clampedIndex(selection.index, rows.length) : found;

  return { index, key: rows[index]?.key };
};

const loadedState = <Value,>(
  current: ListState<Value>,
  loaded: Loaded<Value>,
  rows: ListRow[],
): ListState<Value> => ({ loaded, rows, selection: resolvedSelection(current.selection, rows) });

const useList = <Value,>(
  enabled: boolean,
  load: () => Promise<Result<Value, CliFailure>>,
  generation: number,
  rowsOf: (value: Value) => ListRow[],
) => {
  const [state, setState] = useState<ListState<Value>>({
    loaded: { state: 'loading' },
    rows: [],
    selection: { index: 0, key: undefined },
  });

  useEffect(() => {
    if (!enabled) {
      return;
    }

    load()
      .then((result) => {
        setState((current) =>
          result.ok
            ? loadedState(current, { state: 'loaded', value: result.value }, rowsOf(result.value))
            : loadedState(current, { state: 'failed', message: result.reason.message }, []),
        );
      })
      .catch((error: unknown) => {
        const message = errorMessage(error, 'The list did not load.');

        setState((current) => loadedState(current, { state: 'failed', message }, []));
      });
  }, [enabled, load, generation, rowsOf]);

  const move = (step: number) => {
    setState((current) => {
      const index = clampedIndex(current.selection.index + step, current.rows.length);

      return { ...current, selection: { index, key: current.rows[index]?.key } };
    });
  };

  return [state, move] as const;
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

const homeRowsOfReading = (reading: NeedsReading): ListRow[] => homeRowsOf(reading.items);

const Screen = ({ effects, onQuit }: Omit<AppProps, 'keymap'>): ReactNode => {
  const [view, setView] = useState<ViewName>('home');

  const [treeRequested, setTreeRequested] = useState(false);
  const [notice, setNotice] = useState('');
  const { height } = useTerminalDimensions();
  const generation = useGeneration(effects.onChange);
  const [home, moveHome] = useList(true, effects.load, generation, homeRowsOfReading);
  const [tree, moveTree] = useList(treeRequested, effects.loadTree, generation, treeRowsOf);
  const current = view === 'home' ? home : tree;
  const { rows } = current;
  const selected = current.selection.index;
  const move = view === 'home' ? moveHome : moveTree;

  const edit = (id: string) => {
    effects
      .lend(() => effects.edit(id))
      .then((loan) => {
        if (!loan.ok) {
          return;
        }

        const result = loan.value;

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
  const viewStatus = view === 'home' ? homeStatusOf(home.loaded) : failureStatus(tree.loaded);
  const status = notice === '' ? viewStatus : notice;

  return (
    <box flexDirection="column" flexGrow={1}>
      {current.loaded.state === 'loaded' ? (
        <RowList
          rows={rows}
          selected={selected}
          height={listHeight}
          emptyMessage={view === 'home' ? 'Nothing needs you.' : 'No plans or slices.'}
        />
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
