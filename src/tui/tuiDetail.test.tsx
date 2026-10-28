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

it.each([
  [59, '59s'],
  [60, '1m'],
  [3599, '59m'],
  [3600, '1h'],
  [86_399, '23h'],
  [86_400, '1d'],
])('shows an age of %i seconds as %s in the detail', async (ageSeconds, label) => {
  const item: NeedView = { ...needView(0, 'First'), ageSeconds };
  const { setup } = await mount([item], { width: 120, height: 20 });

  expect(setup.captureCharFrame()).toMatch(new RegExp(`Age\\s+${label}(?!\\w)`));
});

it('shows no age in the detail of an item that has none', async () => {
  const item: NeedView = { ...needView(0, 'First'), since: null, ageSeconds: null };
  const { setup } = await mount([item], { width: 120, height: 20 });

  expect(setup.captureCharFrame()).toContain('demo-3400');
  expect(setup.captureCharFrame()).not.toMatch(/Age\s/);
});

const treeWithPr = (pr: number | null): TreeGroup[] => {
  const [group] = treeGroups();

  if (group === undefined) {
    throw new Error('The demo tree has no group.');
  }

  const [slice] = group.slices;

  if (slice === undefined) {
    throw new Error('The demo tree has no slice.');
  }

  return [{ ...group, slices: [{ ...slice, pr }] }];
};

it('shows the PR number of a slice in the tree detail', async () => {
  const { setup, press, selectedLine } = await mount(
    [],
    { width: 120, height: 20 },
    [],
    treeWithPr(12),
  );

  await press('s');
  await press('j');

  expect(selectedLine()).toContain('demo-3402');
  expect(setup.captureCharFrame()).toMatch(/PR\s+#12/);
});

it('leaves the PR row out of the tree detail for a slice without a PR', async () => {
  const { setup, press, selectedLine } = await mount(
    [],
    { width: 120, height: 20 },
    [],
    treeWithPr(null),
  );

  await press('s');
  await press('j');

  expect(selectedLine()).toContain('demo-3402');
  expect(setup.captureCharFrame()).not.toMatch(/\bPR\b/);
});

it('shows the plan and instruction facts of a tree row in the detail', async () => {
  const { setup, press, selectedLine } = await mount(
    [],
    { width: 120, height: 20 },
    [],
    treeGroups(),
  );

  await press('s');

  expect(selectedLine()).toContain('demo-3401');
  expect(setup.captureCharFrame()).toMatch(/Plan title\s*$/m);
  expect(setup.captureCharFrame()).toMatch(/Plan\s*$/m);

  await press('j');
  await press('j');

  expect(selectedLine()).toContain('demo-3403');
  expect(setup.captureCharFrame()).toMatch(/Instruction title\s*$/m);
  expect(setup.captureCharFrame()).toMatch(/Instruction\s*$/m);
});

const lastNonEmptyRow = (frame: string): string =>
  frame.split('\n').findLast((row) => row.trim() !== '') ?? '';

it('shows no file error in the detail of the row without a plan', async () => {
  const groups: TreeGroup[] = [{ plan: null, slices: [] }];

  const { setup, press, selectedLine } = await mount([], { width: 120, height: 20 }, [], groups, {
    loadErrors: () =>
      Promise.resolve({ ok: true, value: [{ path: 'broken.md', id: null, message: 'Broken' }] }),
  });

  await press('s');

  expect(selectedLine()).toBeDefined();
  expect(setup.captureCharFrame()).not.toContain('Broken');
  expect(setup.captureCharFrame()).not.toContain('broken.md');
});

it('counts a file error with no ticket row as a file error on the tree', async () => {
  const groups: TreeGroup[] = [{ plan: null, slices: [] }];

  const { setup, press } = await mount([], { width: 120, height: 20 }, [], groups, {
    loadErrors: () =>
      Promise.resolve({ ok: true, value: [{ path: 'broken.md', id: null, message: 'Broken' }] }),
  });

  await press('s');

  expect(lastNonEmptyRow(setup.captureCharFrame())).toMatch(/(^|\D)1(\D|$)/);
});

it('keeps each detail fact on its own row when the title is long at 80 by 24', async () => {
  const longTitle = `START-${'x'.repeat(2000)}`;
  const { setup, press } = await mount([needView(0, longTitle)], { width: 80, height: 24 });

  await press('RETURN');

  const lines = setup.captureCharFrame().split('\n');
  const titleAt = lines.findIndex((line) => line.includes('START-'));

  expect(titleAt).toBeGreaterThan(-1);
  // The cut is marked, so the user sees that the title was shortened.
  expect(lines[titleAt] ?? '').toMatch(/\.{3}|…/);
  expect(lines[titleAt + 1] ?? '').toMatch(/\bsubmitted\b/);
  expect(lines[titleAt + 2] ?? '').toMatch(/\b1m\b/);
});

it('keeps the status line free of detail text when the detail is short at 80 by 3', async () => {
  const { setup, press } = await mount([needView(0, 'First')], { width: 80, height: 3 }, [
    'STATUS-MARKER',
  ]);

  await press('RETURN');

  const status = setup.captureCharFrame().split('\n')[2] ?? '';

  expect(status).toMatch(/^\S+\s+STATUS-MARKER\s+.*\?/);
});
