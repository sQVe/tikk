import type { CommandContext } from '@opentui/keymap';
import type { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { KeymapProvider, useBindings } from '@opentui/keymap/react';
import { useTerminalDimensions } from '@opentui/react';
import { useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import { RowList, singleLine } from './rowList.tsx';
import type { TuiSession, TuiSnapshot } from './tuiSession.ts';
import { viewCommands } from './viewKeymap.ts';
import type { ViewIntent } from './viewKeymap.ts';

export { createTuiSession } from './tuiSession.ts';
export type { TuiEffects, TuiSession } from './tuiSession.ts';

export interface AppProps {
  session: TuiSession;
  keymap: ReturnType<typeof createDefaultOpenTuiKeymap>;
  onQuit: () => void;
}

const statusOf = (snapshot: TuiSnapshot): string => {
  const view = snapshot.views[snapshot.view];

  if (snapshot.notice !== '') {
    return snapshot.notice;
  }

  if (view.failure !== undefined) {
    return view.failure;
  }

  return view.loaded ? view.problems.join('; ') : 'Loading...';
};

const Screen = ({ session, onQuit }: Omit<AppProps, 'keymap'>): ReactNode => {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { height } = useTerminalDimensions();
  const view = snapshot.views[snapshot.view];

  useBindings(() => {
    const run = (intent: ViewIntent) => {
      if (intent === 'quit') {
        onQuit();

        return;
      }

      session.send({ kind: intent });
    };

    return {
      bindings: viewCommands.flatMap((command) =>
        command.keys.map((key) => ({
          key,
          cmd: (context: CommandContext) => {
            context.event.preventDefault();
            run(command.intent);
          },
        })),
      ),
    };
  }, [session, onQuit]);

  const listHeight = Math.max(1, height - 1);

  return (
    <box flexDirection="column" flexGrow={1}>
      {view.loaded ? (
        <RowList
          rows={view.rows}
          selected={view.selection.index}
          height={listHeight}
          emptyMessage={snapshot.view === 'home' ? 'Nothing needs you.' : 'No plans or slices.'}
        />
      ) : null}
      <text wrapMode="none" truncate height={1}>
        {singleLine(statusOf(snapshot))}
      </text>
    </box>
  );
};

export const App = ({ session, keymap, onQuit }: AppProps): ReactNode => (
  <KeymapProvider keymap={keymap}>
    <Screen session={session} onQuit={onQuit} />
  </KeymapProvider>
);
