import { afterEach, expect, it } from 'bun:test';

import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { useRenderer } from '@opentui/react';
import { testRender } from '@opentui/react/test-utils';
import { act, useLayoutEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { NeedView, TreeGroup } from '../cli/cli.ts';
import { App } from './tui.tsx';
import type { AppProps } from './tui.tsx';

type Setup = Awaited<ReturnType<typeof testRender>>;

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const openSetups: Setup[] = [];
const changeListeners = new Set<() => void>();
const edited: string[] = [];

// Keys that the probe presses in the commit of the next reload, before passive effects run.
const keysAtCommit: string[] = [];
const probe = { reloaded: (): void => undefined };

// Renders after the app, so its layout effect runs after the app's commit and before any passive
// effect of that commit.
const CommitProbe = ({ setup }: { setup: () => Setup | undefined }): ReactNode => {
  const [reloads, setReloads] = useState(0);

  probe.reloaded = () => {
    setReloads((current) => current + 1);
  };

  useLayoutEffect(() => {
    const mounted = setup();

    for (const key of keysAtCommit.splice(0)) {
      mounted?.mockInput.pressKey(key);
    }
  }, [reloads, setup]);

  return null;
};

const WithKeymap = (props: Omit<AppProps, 'keymap'>): ReactNode => {
  const renderer = useRenderer();
  const keymap = useMemo(() => createDefaultOpenTuiKeymap(renderer), [renderer]);

  return (
    <>
      <App {...props} keymap={keymap} />
      <CommitProbe setup={() => openSetups.at(-1)} />
    </>
  );
};

const needView = (index: number, title: string): NeedView => ({
  id: `demo-${3400 + index}` as NeedView['id'],
  title,
  reason: 'submitted',
  since: '2026-10-20T11:00:00.000Z',
  ageSeconds: 60,
});

const mount = async (
  items: NeedView[],
  size: { width: number; height: number },
  problems: string[] = [],
  groups: TreeGroup[] = [],
  overrides: Partial<AppProps['effects']> = {},
) => {
  const reconcileProblems = problems.map((message) => ({
    ticket: null,
    repository: null,
    number: null,
    message,
  }));

  // Tests change items and groups in place, then call storeChanged to reload.
  const effects: AppProps['effects'] = {
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
    edit: (rawId) => {
      edited.push(rawId);

      return Promise.resolve({ ok: true, value: undefined });
    },
    lend: (run) => run(),
    onChange: (listener) => {
      changeListeners.add(listener);

      return () => changeListeners.delete(listener);
    },
    ...overrides,
  };

  const setup = await act(() =>
    testRender(<WithKeymap effects={effects} onQuit={() => undefined} />, size),
  );

  openSetups.push(setup);

  await act(async () => {
    await Bun.sleep(30);
    await setup.renderOnce();
  });

  return setup;
};

const press = async (setup: Setup, key: string): Promise<void> => {
  await act(async () => {
    if (key === 'up' || key === 'down') {
      setup.mockInput.pressArrow(key);
    } else if (key === 'tab') {
      setup.mockInput.pressTab();
    } else {
      setup.mockInput.pressKey(key);
    }

    await Bun.sleep(20);
    await setup.renderOnce();
  });

  await act(async () => {
    await setup.renderOnce();
  });
};

const storeChanged = async (setup: Setup): Promise<void> => {
  await act(async () => {
    for (const listener of changeListeners) {
      listener();
    }

    await Bun.sleep(20);
    await setup.renderOnce();
  });

  await act(async () => {
    await setup.renderOnce();
  });
};

const selectedLine = (setup: Setup): string | undefined =>
  setup
    .captureCharFrame()
    .split('\n')
    .find((line) => line.startsWith('>'));

afterEach(() => {
  changeListeners.clear();
  keysAtCommit.splice(0);
  edited.splice(0);

  for (const setup of openSetups.splice(0)) {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

it('keeps wide and multi-line titles on one row and the status readable', async () => {
  const items = [
    needView(0, '界'.repeat(30)),
    needView(1, 'One\nTwo'),
    needView(2, 'A very long ASCII title that cannot fit in forty columns'),
    needView(3, 'Fourth'),
  ];

  const setup = await mount(items, { width: 40, height: 6 }, ['STATUS problem\nsecond']);
  const lines = setup.captureCharFrame().split('\n');
  const rows = lines.filter((line) => line.includes('demo-'));

  expect(rows).toHaveLength(4);
  expect(rows[1]).toContain('One Two');

  for (const [index, row] of rows.entries()) {
    expect(row).toMatch(new RegExp(`^[> ] demo-340${index} {2}submi`));
  }

  const status = lines.findIndex((line) => line.includes('STATUS problem second'));

  expect(status).toBe(lines.findIndex((line) => line.includes('demo-3403')) + 1);
});

it('moves the selected row with j, k, down, and up', async () => {
  const items = [needView(0, 'First'), needView(1, 'Second'), needView(2, 'Third')];
  const setup = await mount(items, { width: 60, height: 8 });

  expect(selectedLine(setup)).toContain('First');

  await press(setup, 'j');
  expect(selectedLine(setup)).toContain('Second');

  await press(setup, 'down');
  expect(selectedLine(setup)).toContain('Third');

  await press(setup, 'down');
  expect(selectedLine(setup)).toContain('Third');

  await press(setup, 'k');
  expect(selectedLine(setup)).toContain('Second');

  await press(setup, 'up');
  expect(selectedLine(setup)).toContain('First');

  await press(setup, 'up');
  expect(selectedLine(setup)).toContain('First');
});

const treeGroups = (): TreeGroup[] => {
  const planId = 'demo-3401' as NeedView['id'];
  const activeId = 'demo-3402' as NeedView['id'];
  const taskId = 'demo-3403' as NeedView['id'];

  return [
    {
      plan: { id: planId, title: 'Plan title', status: 'open' },
      slices: [
        {
          id: activeId,
          title: 'Slice title',
          state: 'active',
          pr: 12,
          tasks: [{ id: taskId, title: 'Task title', state: 'open' }],
        },
      ],
    },
  ];
};

it('shows the tree rows on tab and the home items on a second tab', async () => {
  const setup = await mount(
    [needView(0, 'First')],
    { width: 60, height: 8 },
    ['STATUS problem'],
    treeGroups(),
  );

  expect(setup.captureCharFrame()).toContain('First');

  await press(setup, 'tab');

  const tree = setup.captureCharFrame();

  expect(tree).toContain('demo-3401  Plan title  open');
  expect(tree).toContain('demo-3402  Slice title  active  #12');
  expect(tree).toContain('demo-3403  Task title  open');
  expect(tree).not.toContain('First');
  expect(tree).not.toContain('STATUS problem');
  expect(selectedLine(setup)).toContain('Plan title');

  await press(setup, 'j');
  expect(selectedLine(setup)).toContain('Slice title');

  await press(setup, 'tab');

  const home = setup.captureCharFrame();

  expect(home).toContain('First');
  expect(home).not.toContain('Plan title');
});

it('keeps the selected tree row in the frame when the tree is taller than the terminal', async () => {
  const slices = Array.from({ length: 8 }, (_, index) => ({
    id: `demo-${3410 + index}` as NeedView['id'],
    title: `Slice ${index}`,
    state: 'planned' as const,
    pr: null,
    tasks: [],
  }));

  const groups: TreeGroup[] = [{ plan: null, slices }];
  const setup = await mount([], { width: 50, height: 5 }, [], groups);

  await press(setup, 'tab');
  expect(selectedLine(setup)).toContain('No plan');

  for (let step = 0; step < 6; step += 1) {
    await press(setup, 'j');
  }

  expect(selectedLine(setup)).toContain('Slice 5');
  expect(setup.captureCharFrame()).not.toContain('No plan');
});

it('keeps the selected row selected when a reload adds a row above it', async () => {
  const items = [needView(0, 'First'), needView(1, 'Second'), needView(2, 'Third')];
  const setup = await mount(items, { width: 60, height: 8 });

  await press(setup, 'j');
  items.unshift(needView(5, 'Added'));
  await storeChanged(setup);

  expect(setup.captureCharFrame()).toContain('Added');
  expect(selectedLine(setup)).toContain('Second');
});

it('keeps the selected position when a reload removes the selected row', async () => {
  const items = [needView(0, 'First'), needView(1, 'Second'), needView(2, 'Third')];
  const setup = await mount(items, { width: 60, height: 8 });

  await press(setup, 'j');
  items.splice(1, 1);
  await storeChanged(setup);

  expect(setup.captureCharFrame()).not.toContain('Second');
  expect(selectedLine(setup)).toContain('Third');
});

it('reloads the loaded tree when the store changes', async () => {
  const groups = treeGroups();
  const setup = await mount([], { width: 60, height: 8 }, [], groups);

  await press(setup, 'tab');

  const [group] = groups;

  if (group?.plan !== null && group?.plan !== undefined) {
    group.plan.title = 'Renamed plan';
  }

  await storeChanged(setup);

  expect(selectedLine(setup)).toContain('demo-3401  Renamed plan  open');

  if (group?.plan !== null && group?.plan !== undefined) {
    group.plan.title = 'Renamed again';
  }

  await storeChanged(setup);

  expect(selectedLine(setup)).toContain('demo-3401  Renamed again  open');
});

it('opens the selected ticket with e in the home and the tree view', async () => {
  const setup = await mount(
    [needView(0, 'First'), needView(1, 'Second')],
    { width: 60, height: 8 },
    [],
    treeGroups(),
  );

  await press(setup, 'j');
  await press(setup, 'e');
  await press(setup, 'tab');
  await press(setup, 'j');
  await press(setup, 'e');

  expect(edited).toEqual(['demo-3401', 'demo-3402']);
});

it('ignores e on the group of slices without a plan', async () => {
  const groups: TreeGroup[] = [{ plan: null, slices: [] }];
  const setup = await mount([], { width: 60, height: 8 }, [], groups);

  await press(setup, 'tab');
  await press(setup, 'e');

  expect(selectedLine(setup)).toContain('No plan');
  expect(edited).toEqual([]);
});

it('ignores e when the list is empty', async () => {
  const setup = await mount([], { width: 60, height: 8 });

  await press(setup, 'e');

  expect(setup.captureCharFrame()).toContain('Nothing needs you.');
  expect(edited).toEqual([]);
});

it('shows the error of an editor that throws, and clears it after an edit that works', async () => {
  const outcomes = [
    () => Promise.reject(new Error('The editor crashed.')),
    () => Promise.resolve({ ok: true as const, value: undefined }),
  ];

  const setup = await mount([needView(0, 'First')], { width: 60, height: 8 }, [], [], {
    edit: () => outcomes.shift()?.() ?? Promise.reject(new Error('No more edits.')),
  });

  await press(setup, 'e');
  expect(setup.captureCharFrame()).toContain('The editor crashed.');

  await press(setup, 'e');

  const [row, status] = setup.captureCharFrame().split('\n');

  expect(row).toContain('First');
  expect(status?.trim()).toBe('');
});

it('keeps the first row selected when a reload inserts a row before it and no key was pressed', async () => {
  const items = [needView(0, 'First'), needView(1, 'Second')];
  const setup = await mount(items, { width: 60, height: 8 });

  items.unshift(needView(5, 'Added'));
  await storeChanged(setup);

  expect(setup.captureCharFrame()).toContain('Added');
  expect(selectedLine(setup)).toContain('First');
});

it('selects the row at the last position of a moved ticket when a reload removes it', async () => {
  const items = [needView(0, 'First'), needView(1, 'Second'), needView(2, 'Third')];
  const setup = await mount(items, { width: 60, height: 8 });

  await press(setup, 'j');
  items.unshift(needView(5, 'Added'));
  await storeChanged(setup);
  expect(selectedLine(setup)).toContain('Second');

  items.splice(2, 1);
  await storeChanged(setup);

  expect(setup.captureCharFrame()).not.toContain('Second');
  expect(selectedLine(setup)).toContain('Third');

  items.splice(2, 1);
  await storeChanged(setup);

  expect(selectedLine(setup)).toContain('First');
});

it('keeps the selected tree row across reloads that insert and then remove rows', async () => {
  const groups = treeGroups();
  const setup = await mount([], { width: 60, height: 8 }, [], groups);

  await press(setup, 'tab');
  expect(selectedLine(setup)).toContain('Plan title');

  groups.unshift({
    plan: { id: 'demo-3409' as NeedView['id'], title: 'Added plan', status: 'open' },
    slices: [],
  });

  await storeChanged(setup);
  expect(selectedLine(setup)).toContain('Plan title');

  groups.splice(1, 1);
  await storeChanged(setup);

  expect(setup.captureCharFrame()).not.toContain('Plan title');
  expect(selectedLine(setup)).toContain('Added plan');
});

it('opens the row on screen when e arrives in the commit of a reload that removed the selected row', async () => {
  const items = [needView(0, 'A'), needView(1, 'B'), needView(2, 'C')];
  const setup = await mount(items, { width: 60, height: 8 });

  await press(setup, 'j');
  items.splice(1, 1);
  keysAtCommit.push('e');
  await storeChanged(setup);

  expect(selectedLine(setup)).toContain('C');
  expect(edited).toEqual(['demo-3402']);
});

it('moves from the row on screen when j arrives in the commit of a reload', async () => {
  const items = [needView(0, 'A'), needView(1, 'B'), needView(2, 'C'), needView(3, 'D')];
  const setup = await mount(items, { width: 60, height: 8 });

  await press(setup, 'j');
  items.splice(1, 1);
  keysAtCommit.push('j');
  await storeChanged(setup);

  expect(selectedLine(setup)).toContain(' D');

  await press(setup, 'j');
  await press(setup, 'e');

  expect(selectedLine(setup)).toContain(' D');
  expect(edited).toEqual(['demo-3403']);
});

it('moves one row for each j that arrives before the next commit', async () => {
  const items = [needView(0, 'A'), needView(1, 'B'), needView(2, 'C')];
  const setup = await mount(items, { width: 60, height: 8 });

  keysAtCommit.push('j', 'j');
  await storeChanged(setup);

  expect(selectedLine(setup)).toContain(' C');
});

it('opens the tree row on screen when e arrives in the commit of a reload that removed the selected row', async () => {
  const groups = treeGroups();
  const [group] = groups;

  group?.slices.push({
    id: 'demo-3404' as NeedView['id'],
    title: 'Other slice',
    state: 'planned',
    pr: null,
    tasks: [],
  });

  const setup = await mount([], { width: 60, height: 8 }, [], groups);

  await press(setup, 'tab');
  await press(setup, 'j');
  expect(selectedLine(setup)).toContain('Slice title');

  group?.slices.splice(0, 1);
  keysAtCommit.push('e');
  await storeChanged(setup);

  expect(selectedLine(setup)).toContain('Other slice');
  expect(edited).toEqual(['demo-3404']);
});
