import type { CommandContext } from '@opentui/keymap';
import type { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { KeymapProvider, useBindings, useKeymap } from '@opentui/keymap/react';
import { useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import { DetailPane } from './DetailPane.tsx';
import { strayErrorsOf } from './fileErrors.ts';
import { HelpOverlay } from './HelpOverlay.tsx';
import { helpWindowOf } from './helpWindow.ts';
import { MessageOverlay } from './MessageOverlay.tsx';
import { messageWindowOf } from './messageWindow.ts';
import { palette } from './palette.ts';
import { RowList } from './rowList.tsx';
import { StatusLine } from './StatusLine.tsx';
import { catalog, commandsOfLayer, keyNamesOf, scopePriority } from './tuiCommands.ts';
import type { Command, CommandScope } from './tuiCommands.ts';
import type { TuiIntent, TuiSession, TuiSnapshot } from './tuiSession.ts';

export { createTuiSession } from './tuiSession.ts';
export type { TuiEffects, TuiSession } from './tuiSession.ts';

export interface AppProps {
  session: TuiSession;
  keymap: ReturnType<typeof createDefaultOpenTuiKeymap>;
  onQuit: () => void;
}

interface LayerProps {
  scope: CommandScope;
  run: (command: Command) => void;
  session: TuiSession;
}

const primaryStatusOf = (snapshot: TuiSnapshot): string => {
  const view = snapshot.views[snapshot.view];

  if (snapshot.notice !== '') {
    return snapshot.notice;
  }

  if (view.failure !== undefined) {
    return view.failure;
  }

  return view.loaded ? view.problems.join('; ') : 'Loading...';
};

const fileErrorStatusOf = (count: number): string => {
  if (count === 0) {
    return '';
  }

  const noun = count === 1 ? 'error' : 'errors';

  return `${count} file ${noun}`;
};

const statusOf = (snapshot: TuiSnapshot, strayCount: number): string =>
  [primaryStatusOf(snapshot), fileErrorStatusOf(strayCount)]
    .filter((part) => part !== '')
    .join('; ');

const viewLabels: Record<TuiSnapshot['view'], string> = { home: 'Home', tree: 'Tree' };

const sideLayoutMinimumWidth = 90;
const detailMaximumWidth = 44;
const detailShare = 0.36;

const statusRows = 1;

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- scopePriority is a Record over CommandScope
const scopes = Object.keys(scopePriority) as CommandScope[];

const isScopeActive = (scope: CommandScope, snapshot: TuiSnapshot): boolean => {
  const { kind } = snapshot.overlay;

  const active: Record<CommandScope, boolean> = {
    global: true,
    list: kind === 'none' && !snapshot.detailOpen,
    detail: snapshot.detailOpen,
    input: false,
    rank: false,
    visual: false,
    help: kind === 'help',
    messages: kind === 'messages',
  };

  return active[scope];
};

const messagesHeightOf = (height: number): number => Math.max(1, height - statusRows);

const overlayMaximumTop = (snapshot: TuiSnapshot, width: number, height: number): number => {
  if (snapshot.overlay.kind === 'messages') {
    return messageWindowOf(snapshot.messages, width, messagesHeightOf(height)).maximumTop;
  }

  return helpWindowOf(catalog, snapshot, height, width).maximumTop;
};

// The scope comes from the live session, because keys in one burst arrive before React renders
// what the first key changed.
const KeyLayer = ({ scope, run, session }: LayerProps): null => {
  useBindings(() => {
    const scoped = commandsOfLayer(catalog, scope);
    const keys = [...new Set(scoped.flatMap((command) => command.keys))];

    return {
      priority: scopePriority[scope],
      enabled: () => isScopeActive(scope, session.getSnapshot()),
      bindings: keys.map((key) => ({
        key,
        cmd: (context: CommandContext) => {
          const command = scoped.find((candidate) => candidate.keys.includes(key));

          context.event.preventDefault();
          context.event.stopPropagation();

          if (command !== undefined) {
            run(command);
          }
        },
      })),
    };
  }, [scope, run, session]);

  return null;
};

const commandDuringSequence = (
  snapshot: TuiSnapshot,
  matches: (key: string) => boolean,
): Command | undefined => {
  const active = scopes
    .filter((scope) => isScopeActive(scope, snapshot))
    .toSorted((first, second) => scopePriority[second] - scopePriority[first]);

  for (const scope of active) {
    const command = catalog.find(
      (candidate) =>
        candidate.scope === scope && (candidate.keysDuringSequence ?? []).some(matches),
    );

    if (command !== undefined) {
      return command;
    }
  }

  return undefined;
};

// The keymap gives a pending sequence the next key before any binding, so an exit key would end
// the sequence as a miss. A key that misses a pending sequence is dropped, so it never runs as a
// single key.
const PendingSequence = ({ run, session }: Omit<LayerProps, 'scope'>): null => {
  const keymap = useKeymap();

  useEffect(() => {
    const stopExits = keymap.intercept('key', (context) => {
      if (!keymap.hasPendingSequence()) {
        return;
      }

      const matches = (key: string) => keymap.createKeyMatcher(key)(context.event);
      const command = commandDuringSequence(session.getSnapshot(), matches);

      if (command === undefined) {
        return;
      }

      keymap.clearPendingSequence();
      context.consume();
      run(command);
    });

    const stopMisses = keymap.intercept('key:after', (context) => {
      if (context.reason === 'sequence-miss') {
        context.consume();
      }
    });

    return () => {
      stopExits();
      stopMisses();
    };
  }, [keymap, run, session]);

  return null;
};

// The list and the detail pane already sit side by side, so Enter has nothing to open.
const isRedundantDetail = (intent: TuiIntent, sideLayout: boolean): boolean =>
  sideLayout && intent.kind === 'openDetail';

const Screen = ({ session, onQuit }: Omit<AppProps, 'keymap'>): ReactNode => {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { width, height } = useTerminalDimensions();
  const view = snapshot.views[snapshot.view];
  const sideLayout = width >= sideLayoutMinimumWidth;
  const fullDetail = snapshot.detailOpen && !sideLayout;
  const showsPane = sideLayout || fullDetail;
  const detailWidth = Math.min(detailMaximumWidth, Math.floor(width * detailShare));
  const paneWidth = sideLayout ? detailWidth : width;
  const listWidth = sideLayout ? width - detailWidth : width;
  const selectedRow = view.rows[view.selection.index];
  const rows = [...snapshot.views.home.rows, ...snapshot.views.tree.rows];
  const strayCount = strayErrorsOf(snapshot.fileErrors, rows).length;
  const helpKeys = keyNamesOf(catalog, 'help').join('/');

  const run = useCallback(
    (command: Command) => {
      const current = session.getSnapshot();

      if (command.disabledReason(current) !== undefined) {
        return;
      }

      const { intent } = command;

      if (intent.kind === 'quit') {
        onQuit();
      } else if (intent.kind === 'session') {
        if (!isRedundantDetail(intent.intent, sideLayout)) {
          session.send(intent.intent);
        }
      } else {
        const maximumTop = overlayMaximumTop(current, width, height);

        session.send({ kind: 'scrollOverlay', move: intent.move, maximumTop });
      }
    },
    [session, onQuit, width, height, sideLayout],
  );

  // A resize from narrow to side by side ends the full-screen detail, so no list key stays blocked.
  useEffect(() => {
    if (sideLayout && snapshot.detailOpen) {
      session.send({ kind: 'closeDetail' });
    }
  }, [session, sideLayout, snapshot.detailOpen]);

  const listHeight = Math.max(1, height - statusRows);

  return (
    <box flexDirection="column" flexGrow={1}>
      <PendingSequence run={run} session={session} />
      {scopes.map((scope) => (
        <KeyLayer key={scope} scope={scope} run={run} session={session} />
      ))}
      {view.loaded ? (
        <box flexDirection="row">
          {fullDetail ? null : (
            <box width={listWidth} flexShrink={0}>
              <RowList
                rows={view.rows}
                selected={view.selection.index}
                height={listHeight}
                emptyMessage={
                  snapshot.view === 'home' ? 'Nothing needs you.' : 'No plans or slices.'
                }
              />
            </box>
          )}
          {showsPane ? (
            <DetailPane
              row={selectedRow}
              errors={snapshot.fileErrors}
              palette={palette}
              width={paneWidth}
            />
          ) : null}
        </box>
      ) : null}
      <StatusLine
        view={viewLabels[snapshot.view]}
        text={statusOf(snapshot, strayCount)}
        helpKeys={helpKeys}
        palette={palette}
      />
      {snapshot.overlay.kind === 'help' ? (
        <HelpOverlay
          catalog={catalog}
          palette={palette}
          height={height}
          helpWindow={helpWindowOf(catalog, snapshot, height, width)}
          top={snapshot.overlay.top}
        />
      ) : null}
      {snapshot.overlay.kind === 'messages' ? (
        <MessageOverlay
          messageWindow={messageWindowOf(snapshot.messages, width, messagesHeightOf(height))}
          palette={palette}
          height={messagesHeightOf(height)}
          top={snapshot.overlay.top}
        />
      ) : null}
    </box>
  );
};

export const App = ({ session, keymap, onQuit }: AppProps): ReactNode => (
  <KeymapProvider keymap={keymap}>
    <Screen session={session} onQuit={onQuit} />
  </KeymapProvider>
);
