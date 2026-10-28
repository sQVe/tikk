import { afterEach, expect, it } from 'bun:test';

import { createTestRenderer } from '@opentui/core/testing';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { createRoot } from '@opentui/react';
import { act } from 'react';

import type { NeedView, NeedsSession } from './cli/cli.ts';
import { startTerminal } from './terminal.tsx';
import type { TerminalEffects } from './terminal.tsx';
import { createTuiSession, defaultBindings } from './tui/tui.tsx';
import type { TuiEffects } from './tui/tui.tsx';

type Handler = (reason?: unknown) => void;
type Setup = Awaited<ReturnType<typeof createTestRenderer>>;

interface StartOptions {
  width?: number;
  holdOpen?: Promise<unknown>;
  edit?: NeedsSession['edit'];
  resume?: () => void;
  closeFailure?: { kind: 'cleanup'; message: string };
}

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const openSetups: Setup[] = [];

const needView: NeedView = {
  id: 'demo-3467' as NeedView['id'],
  title: 'Asked instruction',
  reason: 'question',
  since: '2026-10-20T11:00:00.000Z',
  ageSeconds: 60,
  item: '0000000000a1',
  passedUp: true,
  text: 'Which one?',
};

const settle = (): Promise<void> =>
  act(async () => {
    await Bun.sleep(30);
  });

const start = async (options: StartOptions = {}) => {
  const setup = await createTestRenderer({ width: options.width ?? 40, height: 10 });
  const handlers = new Map<string, Handler>();
  const calls = { unmount: 0, destroy: 0, dispose: 0 };
  const watcher = { onChange: (): void => undefined, stops: 0, loads: 0 };
  const lending: string[] = [];
  const app: { effects?: TuiEffects } = {};
  const exitCodes: number[] = [];
  const printed: unknown[] = [];
  const destroyedAtPrint: number[] = [];
  const removedHandlers: { event: string; destroyed: number }[] = [];
  const root = createRoot(setup.renderer);
  const destroyRenderer = setup.renderer.destroy.bind(setup.renderer);

  openSetups.push(setup);

  const effects: TerminalEffects = {
    open: () =>
      (options.holdOpen ?? Promise.resolve()).then(() => ({
        renderer: {
          suspend: () => {
            lending.push('suspend');
          },
          resume: () => {
            lending.push('resume');
            options.resume?.();
          },
          destroy: () => {
            calls.destroy += 1;

            act(() => {
              destroyRenderer();
            });
          },
        },
        root: {
          render: (node) => {
            root.render(node);
          },
          unmount: () => {
            calls.unmount += 1;

            act(() => {
              root.unmount();
            });
          },
        },
        keymap: createDefaultOpenTuiKeymap(setup.renderer),
      })),
    listen: (event, handler) => {
      handlers.set(event, handler);

      return () => {
        removedHandlers.push({ event, destroyed: calls.destroy });
        handlers.delete(event);
      };
    },
    exit: (code) => exitCodes.push(code),
    printError: (error) => {
      printed.push(error);
      destroyedAtPrint.push(calls.destroy);
    },
    createSession: (tuiEffects) => {
      app.effects = tuiEffects;

      return createTuiSession(tuiEffects);
    },
  };

  const closing: { gate: Promise<unknown> } = { gate: Promise.resolve() };

  const needs: NeedsSession = {
    load: () => {
      watcher.loads += 1;

      return Promise.resolve({ ok: true, value: { items: [needView], reconcileProblems: [] } });
    },
    loadTree: () => Promise.resolve({ ok: true, value: { current: null, projects: [] } }),
    loadErrors: () => Promise.resolve({ ok: true, value: [] }),
    loadDetail: (rawId) =>
      Promise.resolve({
        ok: false,
        reason: { code: 'notFound', message: `Ticket ${rawId} does not exist.` },
      }),
    edit:
      options.edit ??
      (() => {
        lending.push('edit');

        return Promise.resolve({ ok: true, value: undefined });
      }),
    close: async () => {
      await closing.gate;
      calls.dispose += 1;

      return options.closeFailure === undefined
        ? { ok: true, value: undefined }
        : { ok: false, reason: options.closeFailure };
    },
  };

  const started = startTerminal(
    {
      needs,
      watch: (onChange) => {
        watcher.onChange = onChange;

        return () => {
          watcher.stops += 1;
        };
      },
      bindings: defaultBindings,
      notices: [],
    },
    effects,
  );

  await act(async () => {
    if (options.holdOpen === undefined) {
      await started;
    }
  });

  await settle();

  return {
    setup,
    handlers,
    calls,
    exitCodes,
    printed,
    destroyedAtPrint,
    removedHandlers,
    closing,
    watcher,
    lending,
    app,
  };
};

afterEach(() => {
  for (const setup of openSetups.splice(0)) {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

it('shows the home view on the open renderer', async () => {
  const { setup } = await start();

  await act(async () => {
    await setup.renderOnce();
  });

  expect(setup.captureCharFrame()).toContain('Which one?');
});

it('runs one shutdown when q is pressed', async () => {
  const { setup, calls, exitCodes, handlers } = await start();

  await act(async () => {
    setup.mockInput.pressKey('q');
  });

  await settle();

  expect(calls).toEqual({ unmount: 1, destroy: 1, dispose: 1 });
  expect(exitCodes).toEqual([0]);
  expect(handlers.size).toBe(0);
});

it('runs one shutdown when Ctrl+C is pressed', async () => {
  const { setup, calls, exitCodes } = await start();

  await act(async () => {
    setup.mockInput.pressCtrlC();
  });

  await settle();

  expect(calls).toEqual({ unmount: 1, destroy: 1, dispose: 1 });
  expect(exitCodes).toEqual([0]);
});

it('runs one shutdown on SIGTERM', async () => {
  const { handlers, calls, exitCodes } = await start();

  handlers.get('SIGTERM')?.();
  await settle();

  expect(calls).toEqual({ unmount: 1, destroy: 1, dispose: 1 });
  expect(exitCodes).toEqual([0]);
});

it('runs one shutdown when several exit paths fire', async () => {
  const { setup, handlers, calls, exitCodes } = await start();
  const sigint = handlers.get('SIGINT');
  const sigterm = handlers.get('SIGTERM');

  sigint?.();
  sigterm?.();

  await act(async () => {
    setup.mockInput.pressKey('q');
  });

  await settle();

  expect(calls).toEqual({ unmount: 1, destroy: 1, dispose: 1 });
  expect(exitCodes).toEqual([0]);
});

it('shuts down and exits 1 after a fatal error', async () => {
  const { handlers, calls, exitCodes, printed } = await start();
  const failure = new Error('boom');

  handlers.get('uncaughtException')?.(failure);
  await settle();

  expect(calls).toEqual({ unmount: 1, destroy: 1, dispose: 1 });
  expect(printed).toEqual([failure]);
  expect(exitCodes).toEqual([1]);
});

it('reports a cleanup failure after restoring the terminal exactly once and cancels queued loans', async () => {
  const { app, handlers, calls, exitCodes, printed, destroyedAtPrint, closing, lending } =
    await start({
      closeFailure: { kind: 'cleanup', message: 'Cannot stop editor processes.' },
    });

  const release = Promise.withResolvers<undefined>();
  const queuedCallbacks: string[] = [];

  closing.gate = release.promise;

  const running = app.effects?.lend(() => release.promise);

  await settle();

  const queued = app.effects?.lend(async () => {
    queuedCallbacks.push('queued');
  });

  const quit = handlers.get('SIGTERM');

  quit?.();
  quit?.();
  await settle();

  expect(calls.destroy).toBe(0);
  expect(printed).toEqual([]);
  expect(exitCodes).toEqual([]);

  release.resolve(undefined);
  await running;

  expect(await queued).toEqual({ ok: false, reason: 'cancelled' });

  await settle();

  expect(queuedCallbacks).toEqual([]);
  expect(lending).toEqual(['suspend']);
  expect(calls).toEqual({ unmount: 1, destroy: 1, dispose: 1 });
  expect(destroyedAtPrint).toEqual([1]);
  expect(printed).toEqual(['Cannot stop editor processes.']);
  expect(exitCodes).toEqual([1]);
});

it('keeps exit handlers until restoration and preserves the first fatal failure during close', async () => {
  const { app, handlers, calls, exitCodes, printed, removedHandlers, closing, watcher, lending } =
    await start();

  const release = Promise.withResolvers<undefined>();
  const firstFailure = new Error('first failure');
  const callbacks: string[] = [];

  closing.gate = release.promise;

  const running = app.effects?.lend(() => release.promise);

  await settle();

  const queued = app.effects?.lend(async () => {
    callbacks.push('queued');
  });

  handlers.get('SIGTERM')?.();

  expect(watcher.stops).toBe(1);

  await settle();

  expect([...handlers.keys()]).toEqual([
    'SIGINT',
    'SIGTERM',
    'uncaughtException',
    'unhandledRejection',
  ]);

  expect(removedHandlers).toEqual([]);
  expect(calls).toEqual({ unmount: 1, destroy: 0, dispose: 0 });

  handlers.get('uncaughtException')?.(firstFailure);
  handlers.get('unhandledRejection')?.(new Error('later failure'));
  handlers.get('SIGINT')?.();
  handlers.get('SIGTERM')?.();
  await settle();

  expect(printed).toEqual([]);
  expect(exitCodes).toEqual([]);
  expect(watcher.stops).toBe(1);

  release.resolve(undefined);
  await running;

  expect(await queued).toEqual({ ok: false, reason: 'cancelled' });

  await settle();

  expect(callbacks).toEqual([]);
  expect(lending).toEqual(['suspend']);
  expect(calls).toEqual({ unmount: 1, destroy: 1, dispose: 1 });
  expect(handlers.size).toBe(0);

  expect(removedHandlers).toEqual([
    { event: 'SIGINT', destroyed: 1 },
    { event: 'SIGTERM', destroyed: 1 },
    { event: 'uncaughtException', destroyed: 1 },
    { event: 'unhandledRejection', destroyed: 1 },
  ]);

  expect(printed).toEqual([firstFailure]);
  expect(exitCodes).toEqual([1]);
  expect(watcher.stops).toBe(1);
});

it('exits only after the session finishes closing its pending work', async () => {
  const { handlers, calls, exitCodes, closing } = await start();
  const release = Promise.withResolvers<undefined>();

  closing.gate = release.promise;

  handlers.get('SIGTERM')?.();
  await settle();

  expect(exitCodes).toEqual([]);
  expect(calls.dispose).toBe(0);

  release.resolve(undefined);
  await settle();

  expect(calls).toEqual({ unmount: 1, destroy: 1, dispose: 1 });
  expect(exitCodes).toEqual([0]);
});

it('coalesces store changes into one reload', async () => {
  const { watcher } = await start();

  watcher.onChange();
  watcher.onChange();
  watcher.onChange();

  await act(async () => {
    await Bun.sleep(200);
  });

  expect(watcher.loads).toBe(2);
});

it('stops the watcher at shutdown and runs no reload after it', async () => {
  const { handlers, watcher, exitCodes } = await start();

  watcher.onChange();
  handlers.get('SIGTERM')?.();
  await settle();
  watcher.onChange();

  await act(async () => {
    await Bun.sleep(200);
  });

  expect(exitCodes).toEqual([0]);
  expect(watcher.stops).toBe(1);
  expect(watcher.loads).toBe(1);
});

it('suspends the renderer while e runs the editor, and reloads once after resume', async () => {
  const editorDone = Promise.withResolvers<undefined>();

  const { setup, watcher, lending } = await start({
    edit: async () => {
      lending.push('edit');
      watcher.onChange();
      watcher.onChange();
      await editorDone.promise;

      return { ok: true, value: undefined };
    },
  });

  await act(async () => {
    setup.mockInput.pressKey('e');
  });

  await act(async () => {
    await Bun.sleep(200);
  });

  expect(lending).toEqual(['suspend', 'edit']);
  expect(watcher.loads).toBe(1);

  editorDone.resolve(undefined);
  await settle();

  expect(lending).toEqual(['suspend', 'edit', 'resume']);
  expect(watcher.loads).toBe(2);
});

it('shows the editor failure in the status line and stays open', async () => {
  const { setup, exitCodes } = await start({
    width: 60,
    edit: () =>
      Promise.resolve({
        ok: false,
        reason: { code: 'storeError', message: 'The editor "vi" exited with 1.' },
      }),
  });

  await act(async () => {
    setup.mockInput.pressKey('e');
  });

  await settle();

  await act(async () => {
    await setup.renderOnce();
  });

  expect(setup.captureCharFrame()).toContain('The editor "vi" exited with 1.');
  expect(exitCodes).toEqual([]);
});

it('restores the terminal and exits 1 when resume fails', async () => {
  const failure = new Error('resume failed');

  const { setup, calls, exitCodes, printed } = await start({
    resume: () => {
      throw failure;
    },
  });

  await act(async () => {
    setup.mockInput.pressKey('e');
  });

  await settle();

  expect(calls).toEqual({ unmount: 1, destroy: 1, dispose: 1 });
  expect(printed).toEqual([failure]);
  expect(exitCodes).toEqual([1]);
});

it('runs no reload after the editor when the store did not change', async () => {
  const { setup, watcher, lending } = await start({
    edit: () => {
      lending.push('edit');

      if (lending.length === 2) {
        watcher.onChange();
      }

      return Promise.resolve({ ok: true, value: undefined });
    },
  });

  await act(async () => {
    setup.mockInput.pressKey('e');
  });

  await settle();

  expect(watcher.loads).toBe(2);

  await act(async () => {
    setup.mockInput.pressKey('e');
  });

  await act(async () => {
    await Bun.sleep(200);
  });

  expect(lending).toEqual(['suspend', 'edit', 'resume', 'suspend', 'edit', 'resume']);
  expect(watcher.loads).toBe(2);
});

it('reloads on a later change, but not after an editor that changed nothing', async () => {
  const { setup, watcher, lending } = await start();

  await act(async () => {
    setup.mockInput.pressKey('e');
  });

  await act(async () => {
    await Bun.sleep(200);
  });

  expect(lending).toEqual(['suspend', 'edit', 'resume']);
  expect(watcher.loads).toBe(1);

  watcher.onChange();

  await act(async () => {
    await Bun.sleep(200);
  });

  expect(watcher.loads).toBe(2);
});

it('holds a change that arrives just before the editor, and reloads once after resume', async () => {
  const editorDone = Promise.withResolvers<undefined>();

  const { setup, watcher, lending } = await start({
    edit: async () => {
      lending.push('edit');
      await editorDone.promise;

      return { ok: true, value: undefined };
    },
  });

  watcher.onChange();

  await act(async () => {
    setup.mockInput.pressKey('e');
  });

  await act(async () => {
    await Bun.sleep(200);
  });

  expect(lending).toEqual(['suspend', 'edit']);
  expect(watcher.loads).toBe(1);

  editorDone.resolve(undefined);

  await act(async () => {
    await Bun.sleep(200);
  });

  expect(watcher.loads).toBe(2);
});

it('runs queued editors one after the other and resumes once after the last', async () => {
  const editorGates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()];
  let started = 0;

  const { setup, lending } = await start({
    edit: async () => {
      const gate = editorGates[started];
      started += 1;
      lending.push(`edit ${started}`);
      await gate?.promise;
      lending.push(`end ${started}`);

      return { ok: true, value: undefined };
    },
  });

  await act(async () => {
    setup.mockInput.pressKey('e');
    setup.mockInput.pressKey('e');
  });

  await settle();

  expect(lending).toEqual(['suspend', 'edit 1']);

  editorGates[0]?.resolve(undefined);
  await settle();

  expect(lending).toEqual(['suspend', 'edit 1', 'end 1', 'edit 2']);

  editorGates[1]?.resolve(undefined);
  await settle();

  expect(lending).toEqual(['suspend', 'edit 1', 'end 1', 'edit 2', 'end 2', 'resume']);
});

it('returns cancellation for queued loans without callbacks or renderer resume after shutdown', async () => {
  const editorDone = Promise.withResolvers<string>();
  const { app, handlers, lending, calls, exitCodes, printed } = await start();
  const callbacks: string[] = [];
  const running = app.effects?.lend(() => editorDone.promise);

  const queued = Array.from({ length: 3 }, () =>
    app.effects?.lend(() => {
      callbacks.push('queued');

      return Promise.resolve('queued');
    }),
  );

  const outcomes = Promise.allSettled([running, ...queued]);

  await settle();
  handlers.get('SIGTERM')?.();
  await settle();

  expect(calls.destroy).toBe(1);
  editorDone.resolve('finished');

  expect(await outcomes).toEqual([
    { status: 'fulfilled', value: { ok: true, value: 'finished' } },
    { status: 'fulfilled', value: { ok: false, reason: 'cancelled' } },
    { status: 'fulfilled', value: { ok: false, reason: 'cancelled' } },
    { status: 'fulfilled', value: { ok: false, reason: 'cancelled' } },
  ]);

  const late = await app.effects?.lend(() => {
    callbacks.push('late');

    return Promise.resolve('late');
  });

  expect(late).toEqual({ ok: false, reason: 'cancelled' });
  expect(callbacks).toEqual([]);
  expect(lending).toEqual(['suspend']);
  expect(exitCodes).toEqual([0]);
  expect(printed).toEqual([]);
});

it('stops the running editor and never starts the queued one at shutdown', async () => {
  const editorDone = Promise.withResolvers<undefined>();
  let started = 0;

  const { setup, handlers, exitCodes, calls } = await start({
    edit: async () => {
      started += 1;
      await editorDone.promise;

      return { ok: true, value: undefined };
    },
  });

  await act(async () => {
    setup.mockInput.pressKey('e');
    setup.mockInput.pressKey('e');
  });

  await settle();

  handlers.get('SIGTERM')?.();
  editorDone.resolve(undefined);
  await settle();

  expect(started).toBe(1);
  expect(exitCodes).toEqual([0]);
  expect(calls.dispose).toBe(1);
});

it('shuts down cleanly and exits 0 when SIGTERM arrives before the TUI session opens', async () => {
  const opening = Promise.withResolvers<true>();
  const { handlers, exitCodes, printed } = await start({ holdOpen: opening.promise });

  handlers.get('SIGTERM')?.();
  await settle();

  opening.resolve(true);
  await settle();

  expect(exitCodes).toEqual([0]);
  expect(printed).toEqual([]);
});
