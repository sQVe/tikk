import type { CommandContext } from '@opentui/keymap';
import type { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { KeymapProvider, useBindings, useKeymap } from '@opentui/keymap/react';
import { useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import { HelpOverlay } from './HelpOverlay.tsx';
import { helpWindowOf } from './helpWindow.ts';
import { MessageOverlay } from './MessageOverlay.tsx';
import { messageWindowOf } from './messageWindow.ts';
import { palette } from './palette.ts';
import { RowList, singleLine } from './rowList.tsx';
import { catalog, commandsOfLayer, scopePriority } from './tuiCommands.ts';
import type { Command, CommandScope } from './tuiCommands.ts';
import type { TuiSession, TuiSnapshot } from './tuiSession.ts';

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

const statusRows = 1;

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- scopePriority is a Record over CommandScope
const scopes = Object.keys(scopePriority) as CommandScope[];

const isScopeActive = (scope: CommandScope, overlay: TuiSnapshot['overlay']['kind']): boolean => {
  const active: Record<CommandScope, boolean> = {
    global: true,
    list: overlay === 'none',
    detail: false,
    input: false,
    rank: false,
    visual: false,
    help: overlay === 'help',
    messages: overlay === 'messages',
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
      enabled: () => isScopeActive(scope, session.getSnapshot().overlay.kind),
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
  overlay: TuiSnapshot['overlay']['kind'],
  matches: (key: string) => boolean,
): Command | undefined => {
  const active = scopes
    .filter((scope) => isScopeActive(scope, overlay))
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
      const command = commandDuringSequence(session.getSnapshot().overlay.kind, matches);

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

const Screen = ({ session, onQuit }: Omit<AppProps, 'keymap'>): ReactNode => {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { width, height } = useTerminalDimensions();
  const view = snapshot.views[snapshot.view];

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
        session.send(intent.intent);
      } else {
        const maximumTop = overlayMaximumTop(current, width, height);

        session.send({ kind: 'scrollOverlay', move: intent.move, maximumTop });
      }
    },
    [session, onQuit, width, height],
  );

  const listHeight = Math.max(1, height - statusRows);

  return (
    <box flexDirection="column" flexGrow={1}>
      <PendingSequence run={run} session={session} />
      {scopes.map((scope) => (
        <KeyLayer key={scope} scope={scope} run={run} session={session} />
      ))}
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
