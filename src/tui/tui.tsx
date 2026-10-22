import type { CommandContext } from '@opentui/keymap';
import type { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { KeymapProvider, useBindings } from '@opentui/keymap/react';
import { useTerminalDimensions } from '@opentui/react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { CliFailure, NeedsReading } from '../cli/cli.ts';
import type { Result } from '../result.ts';
import { homeCommands } from './homeKeymap.ts';
import type { HomeIntent } from './homeKeymap.ts';
import { HomeView, singleLine } from './homeView.tsx';

interface TuiEffects {
  load: () => Promise<Result<NeedsReading, CliFailure>>;
}

export interface AppProps {
  effects: TuiEffects;
  keymap: ReturnType<typeof createDefaultOpenTuiKeymap>;
  onQuit: () => void;
}

type Loaded =
  | { state: 'loading' }
  | { state: 'failed'; message: string }
  | { state: 'loaded'; reading: NeedsReading };

const statusOf = (loaded: Loaded): string => {
  if (loaded.state === 'loading') {
    return 'Loading...';
  }

  if (loaded.state === 'failed') {
    return loaded.message;
  }

  return loaded.reading.reconcileProblems.map((problem) => problem.message).join('; ');
};

const itemCountOf = (loaded: Loaded): number =>
  loaded.state === 'loaded' ? loaded.reading.items.length : 0;

const Home = ({ effects, onQuit }: Omit<AppProps, 'keymap'>): ReactNode => {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [selected, setSelected] = useState(0);
  const { height } = useTerminalDimensions();
  const itemCount = itemCountOf(loaded);

  useEffect(() => {
    let current = true;

    const settle = (next: Loaded) => {
      if (current) {
        setLoaded(next);
      }
    };

    effects
      .load()
      .then((result) => {
        settle(
          result.ok
            ? { state: 'loaded', reading: result.value }
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
  }, [effects]);

  const run = (intent: HomeIntent) => {
    if (intent === 'quit') {
      onQuit();
    }

    if (intent === 'moveUp') {
      setSelected((index) => Math.max(0, index - 1));
    }

    if (intent === 'moveDown') {
      setSelected((index) => Math.max(0, Math.min(itemCount - 1, index + 1)));
    }
  };

  useBindings(
    () => ({
      bindings: homeCommands.flatMap((command) =>
        command.keys.map((key) => ({
          key,
          cmd: (context: CommandContext) => {
            context.event.preventDefault();
            run(command.intent);
          },
        })),
      ),
    }),
    [itemCount, onQuit],
  );

  const items = loaded.state === 'loaded' ? loaded.reading.items : [];
  const status = statusOf(loaded);
  const listing = loaded.state === 'loaded';

  return (
    <box flexDirection="column" flexGrow={1}>
      {listing ? (
        <HomeView
          items={items}
          selected={Math.min(selected, Math.max(0, itemCount - 1))}
          height={Math.max(1, height - 1)}
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
    <Home effects={effects} onQuit={onQuit} />
  </KeymapProvider>
);
