import { createCliRenderer } from '@opentui/core';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { createRoot, flushSync } from '@opentui/react';
import type { ReactNode } from 'react';

import type { NeedsSession } from './cli/cli.ts';
import { App } from './tui/tui.tsx';
import type { AppProps } from './tui/tui.tsx';

type ProcessEvent = 'SIGINT' | 'SIGTERM' | 'uncaughtException' | 'unhandledRejection';

interface TerminalRenderer {
  destroy: () => void;
}

interface TerminalRoot {
  render: (node: ReactNode) => void;
  unmount: () => void;
}

export interface TerminalEffects {
  open: () => Promise<{
    renderer: TerminalRenderer;
    root: TerminalRoot;
    keymap: AppProps['keymap'];
  }>;
  listen: (event: ProcessEvent, handler: (reason?: unknown) => void) => () => void;
  exit: (code: number) => void;
  printError: (error: unknown) => void;
}

export interface TerminalDependencies {
  needs: NeedsSession;
}

const openOpenTui: TerminalEffects['open'] = async () => {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [] });

  let created = false;

  try {
    const opened = {
      renderer,
      root: createRoot(renderer),
      keymap: createDefaultOpenTuiKeymap(renderer),
    };

    created = true;

    return opened;
  } finally {
    if (!created) {
      renderer.destroy();
    }
  }
};

const listenToProcess: TerminalEffects['listen'] = (event, handler) => {
  process.on(event, handler);

  return () => {
    process.off(event, handler);
  };
};

const processEffects: TerminalEffects = {
  open: openOpenTui,
  listen: listenToProcess,
  exit: (code) => process.exit(code),
  printError: (error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
  },
};

export const startTerminal = async (
  dependencies: TerminalDependencies,
  effects: TerminalEffects = processEffects,
): Promise<void> => {
  const { needs } = dependencies;
  const removers: (() => void)[] = [];
  let shutdownPromise: Promise<void> | undefined;
  let fatal: { error: unknown } | undefined;
  let finishing = false;

  // Shutdown waits for this promise, so a signal while it is pending still destroys the renderer.
  const openPromise = effects.open();

  const settledOpen = async () => {
    try {
      return await openPromise;
    } catch {
      return undefined;
    }
  };

  const runShutdown = async (): Promise<void> => {
    const opened = await settledOpen();

    try {
      for (const remove of removers.splice(0)) {
        remove();
      }

      opened?.root.unmount();
      await needs.close();
    } finally {
      opened?.renderer.destroy();
    }
  };

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= runShutdown();

    return shutdownPromise;
  };

  const finish = (): void => {
    if (finishing) {
      return;
    }

    finishing = true;

    shutdown()
      .then(
        () => undefined,
        (error: unknown) => {
          fatal ??= { error };
        },
      )
      .then(() => {
        if (fatal === undefined) {
          effects.exit(0);

          return;
        }

        effects.printError(fatal.error);
        effects.exit(1);
      })
      .catch(() => {
        effects.exit(1);
      });
  };

  const quit = (): void => {
    finish();
  };

  const fail = (reason: unknown): void => {
    fatal ??= { error: reason };
    finish();
  };

  removers.push(
    effects.listen('SIGINT', quit),
    effects.listen('SIGTERM', quit),
    effects.listen('uncaughtException', fail),
    effects.listen('unhandledRejection', fail),
  );

  try {
    const { root, keymap } = await openPromise;

    if (shutdownPromise !== undefined) {
      return;
    }

    // The root renders concurrently, so without flushSync the first load would start before the
    // view has mounted.
    flushSync(() => {
      root.render(<App effects={needs} keymap={keymap} onQuit={quit} />);
    });
  } catch (error) {
    fail(error);
  }
};
