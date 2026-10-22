import type { CommandContext } from '@opentui/keymap';
import type { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { KeymapProvider, useBindings } from '@opentui/keymap/react';
import { useTerminalDimensions } from '@opentui/react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { CliFailure, NeedsReading, TreeGroup } from '../cli/cli.ts';
import type { Result } from '../result.ts';
import { HomeView, singleLine } from './homeView.tsx';
import { TreeView, treeRowsOf } from './treeView.tsx';
import { viewCommands } from './viewKeymap.ts';
import type { ViewIntent } from './viewKeymap.ts';

interface TuiEffects {
  load: () => Promise<Result<NeedsReading, CliFailure>>;
  loadTree: () => Promise<Result<TreeGroup[], CliFailure>>;
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

const useLoaded = <Value,>(
  enabled: boolean,
  load: () => Promise<Result<Value, CliFailure>>,
): Loaded<Value> => {
  const [loaded, setLoaded] = useState<Loaded<Value>>({ state: 'loading' });

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    let current = true;

    const settle = (next: Loaded<Value>) => {
      if (current) {
        setLoaded(next);
      }
    };

    load()
      .then((result) => {
        settle(
          result.ok
            ? { state: 'loaded', value: result.value }
            : { state: 'failed', message: result.reason.message },
        );
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'The list did not load.';

        settle({ state: 'failed', message });
      });

    return () => {
      current = false;
    };
  }, [enabled, load]);

  return loaded;
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

const homeCountOf = (loaded: Loaded<NeedsReading>): number =>
  loaded.state === 'loaded' ? loaded.value.items.length : 0;

const treeCountOf = (loaded: Loaded<TreeGroup[]>): number =>
  loaded.state === 'loaded' ? treeRowsOf(loaded.value).length : 0;

const clampedMove = (selected: number, step: number, count: number): number =>
  Math.max(0, Math.min(count - 1, selected + step));

const Screen = ({ effects, onQuit }: Omit<AppProps, 'keymap'>): ReactNode => {
  const [view, setView] = useState<ViewName>('home');
  const [selection, setSelection] = useState({ home: 0, tree: 0 });
  const [treeRequested, setTreeRequested] = useState(false);
  const { height } = useTerminalDimensions();
  const home = useLoaded(true, effects.load);
  const tree = useLoaded(treeRequested, effects.loadTree);
  const count = view === 'home' ? homeCountOf(home) : treeCountOf(tree);

  const run = (intent: ViewIntent) => {
    if (intent === 'quit') {
      onQuit();
    }

    if (intent === 'switchView') {
      setView(view === 'home' ? 'tree' : 'home');
      setTreeRequested(true);
    }

    if (intent === 'moveUp') {
      setSelection((current) => ({ ...current, [view]: clampedMove(current[view], -1, count) }));
    }

    if (intent === 'moveDown') {
      setSelection((current) => ({ ...current, [view]: clampedMove(current[view], 1, count) }));
    }
  };

  useBindings(
    () => ({
      bindings: viewCommands.flatMap((command) =>
        command.keys.map((key) => ({
          key,
          cmd: (context: CommandContext) => {
            context.event.preventDefault();
            run(command.intent);
          },
        })),
      ),
    }),
    [view, count, onQuit],
  );

  const listHeight = Math.max(1, height - 1);
  const selected = Math.min(selection[view], Math.max(0, count - 1));

  return (
    <box flexDirection="column" flexGrow={1}>
      {view === 'home' && home.state === 'loaded' ? (
        <HomeView items={home.value.items} selected={selected} height={listHeight} />
      ) : null}
      {view === 'tree' && tree.state === 'loaded' ? (
        <TreeView groups={tree.value} selected={selected} height={listHeight} />
      ) : null}
      <text wrapMode="none" truncate height={1}>
        {singleLine(view === 'home' ? homeStatusOf(home) : failureStatus(tree))}
      </text>
    </box>
  );
};

export const App = ({ effects, keymap, onQuit }: AppProps): ReactNode => (
  <KeymapProvider keymap={keymap}>
    <Screen effects={effects} onQuit={onQuit} />
  </KeymapProvider>
);
