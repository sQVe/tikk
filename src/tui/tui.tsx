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
import { commandScopes, keysOfAction, scopePriority } from './tuiCommands.ts';
import type { Binding, BindingTable, CommandScope } from './tuiCommands.ts';
import type { TuiIntent, TuiSession, TuiSnapshot } from './tuiSession.ts';

export {
  catalog,
  commandScopes,
  defaultBindings,
  defaultChoiceOf,
  emptyBindingTable,
  expandBindings,
  keysOfAction,
  readableKeyOf,
} from './tuiCommands.ts';

export type { Binding, BindingTable, Command, CommandScope, KeyChoice } from './tuiCommands.ts';

export { createTuiSession } from './tuiSession.ts';
export type { TuiEffects, TuiSession } from './tuiSession.ts';

export interface AppProps {
  session: TuiSession;
  keymap: ReturnType<typeof createDefaultOpenTuiKeymap>;
  bindings: BindingTable;
  onQuit: () => void;
}

interface LayerProps {
  scope: CommandScope;
  run: (binding: Binding) => void;
  session: TuiSession;
  bindings: BindingTable;
}

// The state that decides which scopes are active. One owner: the key layers and the config
// resolver both read it through scopesActiveWith.
interface ActivityState {
  overlay: TuiSnapshot['overlay']['kind'];
  detailOpen: boolean;
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

const isScopeActiveIn = (scope: CommandScope, state: ActivityState): boolean => {
  const active: Record<CommandScope, boolean> = {
    global: true,
    list: state.overlay === 'none' && !state.detailOpen,
    detail: state.detailOpen,
    input: false,
    rank: false,
    visual: false,
    help: state.overlay === 'help',
    messages: state.overlay === 'messages',
  };

  return active[scope];
};

const isScopeActive = (scope: CommandScope, snapshot: TuiSnapshot): boolean =>
  isScopeActiveIn(scope, { overlay: snapshot.overlay.kind, detailOpen: snapshot.detailOpen });

const overlayKinds: readonly ActivityState['overlay'][] = ['none', 'help', 'messages'];

const activityStates: readonly ActivityState[] = overlayKinds.flatMap((overlay) =>
  [false, true].map((detailOpen) => ({ overlay, detailOpen })),
);

// The scopes that can be active in the same state as the given scope, including itself when
// it can be active at all.
export const scopesActiveWith = (scope: CommandScope): CommandScope[] =>
  commandScopes.filter((other) =>
    activityStates.some((state) => isScopeActiveIn(scope, state) && isScopeActiveIn(other, state)),
  );

const messagesHeightOf = (height: number): number => Math.max(1, height - statusRows);

const overlayMaximumTop = (
  bindings: BindingTable,
  snapshot: TuiSnapshot,
  width: number,
  height: number,
): number => {
  if (snapshot.overlay.kind === 'messages') {
    return messageWindowOf(snapshot.messages, width, messagesHeightOf(height)).maximumTop;
  }

  return helpWindowOf(bindings, snapshot, height, width).maximumTop;
};

const KeyLayer = ({ scope, run, session, bindings }: LayerProps): null => {
  useBindings(() => {
    const scoped = bindings[scope];
    const keys = [...new Set(scoped.map((binding) => binding.key))];

    return {
      priority: scopePriority[scope],
      enabled: () => isScopeActive(scope, session.getSnapshot()),
      bindings: keys.map((key) => ({
        key,
        cmd: (context: CommandContext) => {
          const binding = scoped.find((candidate) => candidate.key === key);

          context.event.preventDefault();
          context.event.stopPropagation();

          if (binding !== undefined) {
            run(binding);
          }
        },
      })),
    };
  }, [scope, run, session, bindings]);

  return null;
};

const commandDuringSequence = (
  bindings: BindingTable,
  snapshot: TuiSnapshot,
  matches: (key: string) => boolean,
): Binding | undefined => {
  const active = commandScopes
    .filter((scope) => isScopeActive(scope, snapshot))
    .toSorted((first, second) => scopePriority[second] - scopePriority[first]);

  for (const scope of active) {
    const binding = bindings[scope].find(
      (candidate) => candidate.duringSequence && matches(candidate.key),
    );

    if (binding !== undefined) {
      return binding;
    }
  }

  return undefined;
};

const PendingSequence = ({ run, session, bindings }: Omit<LayerProps, 'scope'>): null => {
  const keymap = useKeymap();

  useEffect(() => {
    const stopExits = keymap.intercept('key', (context) => {
      if (!keymap.hasPendingSequence()) {
        return;
      }

      const matches = (key: string) => keymap.createKeyMatcher(key)(context.event);
      const binding = commandDuringSequence(bindings, session.getSnapshot(), matches);

      if (binding === undefined) {
        return;
      }

      keymap.clearPendingSequence();
      context.consume();
      run(binding);
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
  }, [keymap, run, session, bindings]);

  return null;
};

const isRedundantDetail = (intent: TuiIntent, sideLayout: boolean): boolean =>
  sideLayout && intent.kind === 'openDetail';

const Screen = ({ session, onQuit, bindings }: Omit<AppProps, 'keymap'>): ReactNode => {
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
  const helpKeys = keysOfAction(bindings, 'global', 'help').join('/');

  const run = useCallback(
    (binding: Binding) => {
      const current = session.getSnapshot();
      const { command, overlayMove } = binding;

      if (command.disabledReason(current) !== undefined) {
        return;
      }

      if (overlayMove !== undefined) {
        const maximumTop = overlayMaximumTop(bindings, current, width, height);

        session.send({ kind: 'scrollOverlay', move: overlayMove, maximumTop });

        return;
      }

      const { intent } = command;

      if (intent.kind === 'quit') {
        onQuit();
      } else if (!isRedundantDetail(intent.intent, sideLayout)) {
        session.send(intent.intent);
      }
    },
    [session, onQuit, bindings, width, height, sideLayout],
  );

  useEffect(() => {
    if (sideLayout && snapshot.detailOpen) {
      session.send({ kind: 'closeDetail' });
    }
  }, [session, sideLayout, snapshot.detailOpen]);

  const listHeight = Math.max(0, height - statusRows);
  const hasContentRows = listHeight > 0;

  return (
    <box flexDirection="column" flexGrow={1}>
      <PendingSequence run={run} session={session} bindings={bindings} />
      {commandScopes.map((scope) => (
        <KeyLayer key={scope} scope={scope} run={run} session={session} bindings={bindings} />
      ))}
      <box height={listHeight} flexShrink={0}>
        {view.loaded && hasContentRows ? (
          <box flexDirection="row">
            {fullDetail ? null : (
              <box width={listWidth} flexShrink={0}>
                <RowList
                  rows={view.rows}
                  selected={view.selection.index}
                  height={listHeight}
                  palette={palette}
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
      </box>
      <StatusLine
        view={viewLabels[snapshot.view]}
        text={statusOf(snapshot, strayCount)}
        helpKeys={helpKeys}
        palette={palette}
      />
      {snapshot.overlay.kind === 'help' ? (
        <HelpOverlay
          bindings={bindings}
          palette={palette}
          height={height}
          helpWindow={helpWindowOf(bindings, snapshot, height, width)}
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

export const App = ({ session, keymap, onQuit, bindings }: AppProps): ReactNode => (
  <KeymapProvider keymap={keymap}>
    <Screen session={session} onQuit={onQuit} bindings={bindings} />
  </KeymapProvider>
);
