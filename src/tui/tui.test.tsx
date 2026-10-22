import { afterEach, expect, it } from 'bun:test';

import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { useRenderer } from '@opentui/react';
import { testRender } from '@opentui/react/test-utils';
import { act, useMemo } from 'react';
import type { ReactNode } from 'react';

import type { NeedView, TreeGroup } from '../cli/cli.ts';
import { App } from './tui.tsx';
import type { AppProps } from './tui.tsx';

type Setup = Awaited<ReturnType<typeof testRender>>;

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const openSetups: Setup[] = [];

const WithKeymap = (props: Omit<AppProps, 'keymap'>): ReactNode => {
  const renderer = useRenderer();
  const keymap = useMemo(() => createDefaultOpenTuiKeymap(renderer), [renderer]);

  return <App {...props} keymap={keymap} />;
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
) => {
  const reconcileProblems = problems.map((message) => ({
    ticket: null,
    repository: null,
    number: null,
    message,
  }));

  const effects = {
    load: () => Promise.resolve({ ok: true as const, value: { items, reconcileProblems } }),
    loadTree: () => Promise.resolve({ ok: true as const, value: groups }),
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

const selectedLine = (setup: Setup): string | undefined =>
  setup
    .captureCharFrame()
    .split('\n')
    .find((line) => line.startsWith('>'));

afterEach(() => {
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
  const setup = await mount([needView(0, 'First')], { width: 60, height: 8 }, [], treeGroups());

  expect(setup.captureCharFrame()).toContain('First');

  await press(setup, 'tab');

  const tree = setup.captureCharFrame();

  expect(tree).toContain('demo-3401  Plan title  open');
  expect(tree).toContain('demo-3402  Slice title  active  #12');
  expect(tree).toContain('demo-3403  Task title  open');
  expect(tree).not.toContain('First');
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
