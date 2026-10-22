import { afterEach, expect, it } from 'bun:test';

import { createTestRenderer } from '@opentui/core/testing';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { createRoot } from '@opentui/react';
import { act } from 'react';

import type { NeedsSession } from './cli/cli.ts';
import { startTerminal } from './terminal.tsx';
import type { TerminalEffects } from './terminal.tsx';

type Handler = (reason?: unknown) => void;
type Setup = Awaited<ReturnType<typeof createTestRenderer>>;

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const openSetups: Setup[] = [];

const settle = (): Promise<void> =>
  act(async () => {
    await Bun.sleep(30);
  });

const start = async () => {
  const setup = await createTestRenderer({ width: 40, height: 10 });
  const handlers = new Map<string, Handler>();
  const calls = { unmount: 0, destroy: 0, dispose: 0 };
  const exitCodes: number[] = [];
  const printed: unknown[] = [];
  const root = createRoot(setup.renderer);
  const destroyRenderer = setup.renderer.destroy.bind(setup.renderer);

  openSetups.push(setup);

  const effects: TerminalEffects = {
    open: () =>
      Promise.resolve({
        renderer: {
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
      }),
    listen: (event, handler) => {
      handlers.set(event, handler);

      return () => handlers.delete(event);
    },
    exit: (code) => exitCodes.push(code),
    printError: (error) => printed.push(error),
  };

  const closing: { gate: Promise<unknown> } = { gate: Promise.resolve() };

  const needs: NeedsSession = {
    load: () => Promise.resolve({ ok: true, value: { items: [], reconcileProblems: [] } }),
    close: async () => {
      await closing.gate;
      calls.dispose += 1;
    },
  };

  await act(async () => {
    await startTerminal({ needs }, effects);
  });

  await settle();

  return { setup, handlers, calls, exitCodes, printed, closing };
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

  expect(setup.captureCharFrame()).toContain('Nothing needs you.');
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
