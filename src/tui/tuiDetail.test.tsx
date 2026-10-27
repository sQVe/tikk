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
