import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { useRenderer } from '@opentui/react';
import { testRender } from '@opentui/react/test-utils';
import { act, useLayoutEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { NeedView, TreeGroup } from '../cli/cli.ts';
import { invariant } from '../invariant.ts';
import { App, catalog, createTuiSession, defaultBindings } from './tui.tsx';
import type { AppProps, BindingTable, TuiEffects } from './tui.tsx';

type Setup = Awaited<ReturnType<typeof testRender>>;

interface CommitProbeControls {
  setup: Setup | undefined;
  keysAtCommit: string[];
  reloaded: () => void;
}

export interface TuiFixture {
  setup: Setup;
  edited: string[];
  quits: () => number;
  press: (key: string, modifiers?: { ctrl: boolean }) => Promise<void>;
  storeChanged: () => Promise<void>;
  selectedLine: () => string | undefined;
  pressAtNextCommit: (...keys: string[]) => void;
  cleanup: () => void;
}

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const firstDemoNumber = 3400;
const mountSettleMilliseconds = 30;
const keySettleMilliseconds = 20;

// Renders after the app, so its layout effect runs after the app's commit and before any passive
// effect of that commit.
const CommitProbe = ({ probe }: { probe: CommitProbeControls }): ReactNode => {
  const [reloads, setReloads] = useState(0);

  probe.reloaded = () => {
    setReloads((current) => current + 1);
  };

  useLayoutEffect(() => {
    for (const key of probe.keysAtCommit.splice(0)) {
      probe.setup?.mockInput.pressKey(key);
    }
  }, [reloads, probe]);

  return null;
};

const WithKeymap = ({
  probe,
  ...props
}: Omit<AppProps, 'keymap'> & { probe: CommitProbeControls }): ReactNode => {
  const renderer = useRenderer();
  const keymap = useMemo(() => createDefaultOpenTuiKeymap(renderer), [renderer]);

  return (
    <>
      <App {...props} keymap={keymap} />
      <CommitProbe probe={probe} />
    </>
  );
};

const isDemoId = (raw: string): raw is NeedView['id'] => /^demo-\d+$/.test(raw);

const demoId = (raw: string): NeedView['id'] => {
  invariant(isDemoId(raw), `Test ID ${raw} is invalid.`);

  return raw;
};

// The label of a command as the catalog defines it, so tests track rewording of the label.
export const commandLabel = (id: string): string => {
  const command = catalog.find((candidate) => candidate.id === id);

  invariant(command !== undefined, `The catalog has no ${id} command.`);

  return command.label;
};

export const needView = (index: number, title: string): NeedView => ({
  id: demoId(`demo-${firstDemoNumber + index}`),
  title,
  reason: 'submitted',
  since: '2026-10-20T11:00:00.000Z',
  ageSeconds: 60,
  item: 'abc123def456',
  passedUp: true,
});

export const treeGroups = (): TreeGroup[] => {
  const planId = demoId('demo-3401');
  const activeId = demoId('demo-3402');
  const instructionId = demoId('demo-3403');

  return [
    {
      plan: { id: planId, title: 'Plan title', state: 'open' },
      slices: [
        {
          id: activeId,
          title: 'Slice title',
          state: 'active',
          pr: 12,
          instructions: [{ id: instructionId, title: 'Instruction title', state: 'open' }],
        },
      ],
    },
  ];
};

export const createTuiFixture = async (
  items: NeedView[],
  size: { width: number; height: number },
  problems: string[] = [],
  groups: TreeGroup[] = [],
  overrides: Partial<TuiEffects> = {},
  bindings: BindingTable = defaultBindings,
  notices: string[] = [],
): Promise<TuiFixture> => {
  const changeListeners = new Set<() => void>();
  const edited: string[] = [];
  let quitCount = 0;

  const probe: CommitProbeControls = {
    setup: undefined,
    keysAtCommit: [],
    reloaded: () => undefined,
  };

  const reconcileProblems = problems.map((message) => ({
    ticket: null,
    repository: null,
    number: null,
    message,
  }));

  const effects: TuiEffects = {
    load: () => {
      const loaded = Promise.resolve({
        ok: true as const,
        value: { items: [...items], reconcileProblems },
      });

      return loaded.then((result) => {
        probe.reloaded();

        return result;
      });
    },
    loadTree: () => {
      const loaded = Promise.resolve({ ok: true as const, value: structuredClone(groups) });

      return loaded.then((result) => {
        probe.reloaded();

        return result;
      });
    },
    loadErrors: () => Promise.resolve({ ok: true, value: [] }),
    edit: (rawId) => {
      edited.push(rawId);

      return Promise.resolve({ ok: true, value: undefined });
    },
    lend: async (run) => ({ ok: true, value: await run() }),
    onChange: (listener) => {
      changeListeners.add(listener);

      return () => changeListeners.delete(listener);
    },
    notices,
    ...overrides,
  };

  const session = createTuiSession(effects);

  const setup = await act(() =>
    testRender(
      <WithKeymap
        session={session}
        bindings={bindings}
        onQuit={() => {
          quitCount += 1;
        }}
        probe={probe}
      />,
      size,
    ),
  );

  probe.setup = setup;

  const cleanup = (): void => {
    session.stop();
    changeListeners.clear();
    probe.keysAtCommit.splice(0);

    act(() => {
      setup.renderer.destroy();
    });
  };

  let settled = false;

  // The caller gets no fixture to clean up when settling fails, so the renderer is destroyed here.
  try {
    await act(async () => {
      await Bun.sleep(mountSettleMilliseconds);
      await setup.renderOnce();
    });

    settled = true;
  } finally {
    if (!settled) {
      cleanup();
    }
  }

  const press = async (key: string, modifiers?: { ctrl: boolean }): Promise<void> => {
    await act(async () => {
      if (key === 'up' || key === 'down') {
        setup.mockInput.pressArrow(key);
      } else {
        setup.mockInput.pressKey(key, modifiers);
      }

      await Bun.sleep(keySettleMilliseconds);
      await setup.renderOnce();
    });

    await act(async () => {
      await setup.renderOnce();
    });
  };

  const storeChanged = async (): Promise<void> => {
    await act(async () => {
      for (const listener of changeListeners) {
        listener();
      }

      await Bun.sleep(keySettleMilliseconds);
      await setup.renderOnce();
    });

    await act(async () => {
      await setup.renderOnce();
    });
  };

  const selectedLine = (): string | undefined =>
    setup
      .captureCharFrame()
      .split('\n')
      .find((line) => line.startsWith('>'));

  const pressAtNextCommit = (...keys: string[]): void => {
    probe.keysAtCommit.push(...keys);
  };

  return {
    setup,
    edited,
    quits: () => quitCount,
    press,
    storeChanged,
    selectedLine,
    pressAtNextCommit,
    cleanup,
  };
};
