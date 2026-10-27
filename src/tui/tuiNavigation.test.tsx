import { afterEach, expect, it } from 'bun:test';

import type { NeedView, TreeGroup } from '../cli/cli.ts';
import { createTuiFixture, needView, treeGroups } from './tuiHarness.tsx';
import type { TuiFixture } from './tuiHarness.tsx';

let fixture: TuiFixture | undefined;

const mount = async (...args: Parameters<typeof createTuiFixture>): Promise<TuiFixture> => {
  fixture = await createTuiFixture(...args);

  return fixture;
};

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

it('keeps wide and multi-line titles on one row and the status readable', async () => {
  const items = [
    needView(0, '界'.repeat(30)),
    needView(1, 'One\nTwo'),
    needView(2, 'A very long ASCII title that cannot fit in forty columns'),
    needView(3, 'Fourth'),
  ];

  const { setup } = await mount(items, { width: 40, height: 6 }, ['STATUS problem\nsecond']);
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
  const { press, selectedLine } = await mount(items, { width: 60, height: 8 });

  expect(selectedLine()).toContain('First');

  await press('j');
  expect(selectedLine()).toContain('Second');

  await press('down');
  expect(selectedLine()).toContain('Third');

  await press('down');
  expect(selectedLine()).toContain('Third');

  await press('k');
  expect(selectedLine()).toContain('Second');

  await press('up');
  expect(selectedLine()).toContain('First');

  await press('up');
  expect(selectedLine()).toContain('First');
});

it('shows the tree rows on s and the home items on a second s', async () => {
  const { setup, press, selectedLine } = await mount(
    [needView(0, 'First')],
    { width: 60, height: 8 },
    ['STATUS problem'],
    treeGroups(),
  );

  expect(setup.captureCharFrame()).toContain('First');

  await press('s');

  const tree = setup.captureCharFrame();

  expect(tree).toContain('demo-3401  Plan title  open');
  expect(tree).toContain('demo-3402  Slice title  active  #12');
  expect(tree).toContain('demo-3403  Instruction title  open');
  expect(tree).not.toContain('First');
  expect(tree).not.toContain('STATUS problem');
  expect(selectedLine()).toContain('Plan title');

  await press('j');
  expect(selectedLine()).toContain('Slice title');

  await press('s');

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
    instructions: [],
  }));

  const groups: TreeGroup[] = [{ plan: null, slices }];
  const { setup, press, selectedLine } = await mount([], { width: 50, height: 5 }, [], groups);

  await press('s');
  expect(selectedLine()).toContain('No plan');

  for (let step = 0; step < 6; step += 1) {
    await press('j');
  }

  expect(selectedLine()).toContain('Slice 5');
  expect(setup.captureCharFrame()).not.toContain('No plan');
});

it('opens the selected ticket with e in the home and the tree view', async () => {
  const { edited, press } = await mount(
    [needView(0, 'First'), needView(1, 'Second')],
    { width: 60, height: 8 },
    [],
    treeGroups(),
  );

  await press('j');
  await press('e');
  await press('s');
  await press('e');
  await press('j');
  await press('e');

  expect(edited).toEqual(['demo-3401', 'demo-3401', 'demo-3402']);
});

it('keeps the selected ticket when s switches to a view that has it', async () => {
  const { press, selectedLine } = await mount(
    [needView(0, 'First'), needView(2, 'Instruction need')],
    { width: 60, height: 8 },
    [],
    treeGroups(),
  );

  await press('j');
  await press('s');

  expect(selectedLine()).toContain('demo-3402  Slice title');

  await press('j');
  await press('s');

  expect(selectedLine()).toContain('Instruction need');
});

it('ignores e on the group of slices without a plan', async () => {
  const groups: TreeGroup[] = [{ plan: null, slices: [] }];
  const { edited, press, selectedLine } = await mount([], { width: 60, height: 8 }, [], groups);

  await press('s');
  await press('e');

  expect(selectedLine()).toContain('No plan');
  expect(edited).toEqual([]);
});

it('ignores e when the list is empty', async () => {
  const { setup, edited, press } = await mount([], { width: 60, height: 8 });

  await press('e');

  expect(setup.captureCharFrame()).toContain('Nothing needs you.');
  expect(edited).toEqual([]);
});

it('handles a cancelled terminal loan without editing or replacing the current notice', async () => {
  let attempts = 0;

  const { setup, edited, press } = await mount(
    [needView(1, 'Asked instruction')],
    { width: 60, height: 10 },
    [],
    [],
    {
      lend: () => {
        attempts += 1;

        if (attempts === 1) {
          return Promise.reject(new Error('The editor crashed.'));
        }

        return Promise.resolve({ ok: false, reason: 'cancelled' });
      },
    },
  );

  await press('e');
  expect(setup.captureCharFrame()).toContain('The editor crashed.');

  const before = setup.captureCharFrame();

  await press('e');

  expect(attempts).toBe(2);
  expect(edited).toEqual([]);
  expect(setup.captureCharFrame()).toBe(before);
});

it('shows the error of an editor that throws, and clears it after an edit that works', async () => {
  const outcomes = [
    () => Promise.reject(new Error('The editor crashed.')),
    () => Promise.resolve({ ok: true as const, value: undefined }),
  ];

  const { setup, press } = await mount([needView(0, 'First')], { width: 60, height: 8 }, [], [], {
    edit: () => outcomes.shift()?.() ?? Promise.reject(new Error('No more edits.')),
  });

  await press('e');
  expect(setup.captureCharFrame()).toContain('The editor crashed.');

  await press('e');

  const [row, status] = setup.captureCharFrame().split('\n');

  expect(row).toContain('First');
  expect(status).not.toContain('The editor crashed.');
});
