import { createCliRenderer } from '@opentui/core';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { createRoot, flushSync } from '@opentui/react';
import type { ReactNode } from 'react';

import type { NeedsSession } from './cli/cli.ts';
import { App } from './tui/tui.tsx';
import type { AppProps } from './tui/tui.tsx';

type ProcessEvent = 'SIGINT' | 'SIGTERM' | 'uncaughtException' | 'unhandledRejection';

interface TerminalRenderer {
  suspend: () => void;
  resume: () => void;
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

type StoreWatch = (onChange: () => void) => () => void;

export interface TerminalDependencies {
  needs: NeedsSession;
  watch: StoreWatch;
}

const changeDelayMilliseconds = 100;

const createChangeFeed = (watch: StoreWatch) => {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lent = false;
  let held = false;

  const notify = () => {
    timer = undefined;

    for (const listener of listeners) {
      listener();
    }
  };

  const onChange = () => {
    if (lent) {
      held = true;

      return;
    }

    timer ??= setTimeout(notify, changeDelayMilliseconds);
  };

  const stopWatching = watch(onChange);

  const subscribe = (listener: () => void) => {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  };

  const hold = () => {
    lent = true;

    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      held = true;
    }
  };

  const release = () => {
    lent = false;

    if (held) {
      held = false;
      notify();
    }
  };

  const stop = () => {
    clearTimeout(timer);
    stopWatching();
  };

  return { subscribe, hold, release, stop };
};

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
  const changes = createChangeFeed(dependencies.watch);
  const removers: (() => void)[] = [changes.stop];
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

      const closed = await needs.close();

      if (!closed.ok) {
        fatal ??= { error: closed.reason.message };
      }
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

  let loanTail: Promise<undefined> = Promise.resolve(undefined);
  let pendingLoans = 0;
  let suspended = false;

  const endLoan = (renderer: TerminalRenderer): void => {
    pendingLoans -= 1;

    if (pendingLoans > 0 || !suspended) {
      return;
    }

    suspended = false;

    if (shutdownPromise !== undefined) {
      return;
    }

    try {
      renderer.resume();
      changes.release();
    } catch (error) {
      fail(error);
    }
  };

  const lend: AppProps['effects']['lend'] = async (run) => {
    const previous = loanTail;
    const turn = Promise.withResolvers<undefined>();

    loanTail = turn.promise;
    pendingLoans += 1;

    const { renderer } = await openPromise;

    try {
      await previous;

      if (shutdownPromise !== undefined) {
        return { ok: false, reason: 'cancelled' };
      }

      if (!suspended) {
        renderer.suspend();
        changes.hold();
        suspended = true;
      }

      const value = await run();

      return { ok: true, value };
    } finally {
      endLoan(renderer);
      turn.resolve(undefined);
    }
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
      root.render(
        <App
          effects={{ ...needs, lend, onChange: changes.subscribe }}
          keymap={keymap}
          onQuit={quit}
        />,
      );
    });
  } catch (error) {
    fail(error);
  }
};
