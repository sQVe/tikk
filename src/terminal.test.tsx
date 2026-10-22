import { afterEach, expect, it } from 'bun:test';

import { createTestRenderer } from '@opentui/core/testing';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { createRoot } from '@opentui/react';
import { act } from 'react';

import type { NeedView, NeedsSession } from './cli/cli.ts';
import { startTerminal } from './terminal.tsx';
import type { TerminalEffects } from './terminal.tsx';

type Handler = (reason?: unknown) => void;
type Setup = Awaited<ReturnType<typeof createTestRenderer>>;

interface StartOptions {
  edit?: NeedsSession['edit'];
  resume?: () => void;
}

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const openSetups: Setup[] = [];

const needView: NeedView = {
  id: 'demo-3467' as NeedView['id'],
  title: 'Asked task',
  reason: 'question',
  since: '2026-10-20T11:00:00.000Z',
  ageSeconds: 60,
};

const settle = (): Promise<void> =>
  act(async () => {
    await Bun.sleep(30);
  });

const start = async (options: StartOptions = {}) => {
  const setup = await createTestRenderer({ width: 40, height: 10 });
  const handlers = new Map<string, Handler>();
  const calls = { unmount: 0, destroy: 0, dispose: 0 };
  const watcher = { onChange: (): void => undefined, stops: 0, loads: 0 };
  const lending: string[] = [];
  const exitCodes: number[] = [];
  const printed: unknown[] = [];
  const root = createRoot(setup.renderer);
  const destroyRenderer = setup.renderer.destroy.bind(setup.renderer);

  openSetups.push(setup);

  const effects: TerminalEffects = {
    open: () =>
      Promise.resolve({
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
    load: () => {
      watcher.loads += 1;

      return Promise.resolve({ ok: true, value: { items: [needView], reconcileProblems: [] } });
    },
    loadTree: () => Promise.resolve({ ok: true, value: [] }),
    edit:
      options.edit ??
      (() => {
        lending.push('edit');

        return Promise.resolve({ ok: true, value: undefined });
      }),
    close: async () => {
      await closing.gate;
      calls.dispose += 1;
    },
  };

  await act(async () => {
    await startTerminal(
      {
        needs,
        watch: (onChange) => {
          watcher.onChange = onChange;

          return () => {
            watcher.stops += 1;
          };
        },
      },
      effects,
    );
  });

  await settle();

  return { setup, handlers, calls, exitCodes, printed, closing, watcher, lending };
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

  expect(setup.captureCharFrame()).toContain('Asked task');
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
