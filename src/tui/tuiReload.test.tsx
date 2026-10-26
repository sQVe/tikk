import { afterEach, expect, it } from 'bun:test';

import type { NeedView } from '../cli/cli.ts';
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

it('shows a failed home read and recovers on a successful store refresh', async () => {
  let failed = true;

  const { setup, edited, press, storeChanged, selectedLine } = await mount(
    [],
    { width: 60, height: 8 },
    [],
    [],
    {
      load: async () => {
        if (failed) {
          return { ok: false, reason: { code: 'storeError', message: 'Home read failed.' } };
        }

        return {
          ok: true,
          value: { items: [needView(0, 'Recovered home')], reconcileProblems: [] },
        };
      },
    },
  );

  expect(setup.captureCharFrame()).toContain('Home read failed.');
  expect(selectedLine()).toBeUndefined();

  await press('e');
  expect(edited).toEqual([]);

  failed = false;
  await storeChanged();

  expect(setup.captureCharFrame()).not.toContain('Home read failed.');
  expect(selectedLine()).toContain('Recovered home');

  await press('e');
  expect(edited).toEqual(['demo-3400']);
});

it('shows a failed tree read and recovers on a successful store refresh', async () => {
  let failed = true;

  const { setup, edited, press, storeChanged, selectedLine } = await mount(
    [],
    { width: 60, height: 8 },
    [],
    [],
    {
      loadTree: async () => {
        if (failed) {
          return { ok: false, reason: { code: 'storeError', message: 'Tree read failed.' } };
        }

        return { ok: true, value: treeGroups() };
      },
    },
  );

  await press('tab');

  expect(setup.captureCharFrame()).toContain('Tree read failed.');
  expect(selectedLine()).toBeUndefined();

  await press('e');
  expect(edited).toEqual([]);

  failed = false;
  await storeChanged();

  expect(setup.captureCharFrame()).not.toContain('Tree read failed.');
  expect(selectedLine()).toContain('Plan title');
  expect(setup.captureCharFrame()).toContain('Instruction title');

  await press('e');
  expect(edited).toEqual(['demo-3401']);
});

it('keeps the selected row selected when a reload adds a row above it', async () => {
  const items = [needView(0, 'First'), needView(1, 'Second'), needView(2, 'Third')];
  const { setup, press, storeChanged, selectedLine } = await mount(items, { width: 60, height: 8 });

  await press('j');
  items.unshift(needView(5, 'Added'));
  await storeChanged();

  expect(setup.captureCharFrame()).toContain('Added');
  expect(selectedLine()).toContain('Second');
});

it('keeps the selected position when a reload removes the selected row', async () => {
  const items = [needView(0, 'First'), needView(1, 'Second'), needView(2, 'Third')];
  const { setup, press, storeChanged, selectedLine } = await mount(items, { width: 60, height: 8 });

  await press('j');
  items.splice(1, 1);
  await storeChanged();

  expect(setup.captureCharFrame()).not.toContain('Second');
  expect(selectedLine()).toContain('Third');
});

it('reloads the loaded tree when the store changes', async () => {
  const groups = treeGroups();

  const { press, storeChanged, selectedLine } = await mount(
    [],
    { width: 60, height: 8 },
    [],
    groups,
  );

  await press('tab');

  const [group] = groups;

  if (group?.plan !== null && group?.plan !== undefined) {
    group.plan.title = 'Renamed plan';
  }

  await storeChanged();

  expect(selectedLine()).toContain('demo-3401  Renamed plan  open');

  if (group?.plan !== null && group?.plan !== undefined) {
    group.plan.title = 'Renamed again';
  }

  await storeChanged();

  expect(selectedLine()).toContain('demo-3401  Renamed again  open');
});

it('keeps the first row selected when a reload inserts a row before it and no key was pressed', async () => {
  const items = [needView(0, 'First'), needView(1, 'Second')];
  const { setup, storeChanged, selectedLine } = await mount(items, { width: 60, height: 8 });

  items.unshift(needView(5, 'Added'));
  await storeChanged();

  expect(setup.captureCharFrame()).toContain('Added');
  expect(selectedLine()).toContain('First');
});

it('selects the row at the last position of a moved ticket when a reload removes it', async () => {
  const items = [needView(0, 'First'), needView(1, 'Second'), needView(2, 'Third')];
  const { setup, press, storeChanged, selectedLine } = await mount(items, { width: 60, height: 8 });

  await press('j');
  items.unshift(needView(5, 'Added'));
  await storeChanged();
  expect(selectedLine()).toContain('Second');

  items.splice(2, 1);
  await storeChanged();

  expect(setup.captureCharFrame()).not.toContain('Second');
  expect(selectedLine()).toContain('Third');

  items.splice(2, 1);
  await storeChanged();

  expect(selectedLine()).toContain('First');
});

it('keeps the selected tree row across reloads that insert and then remove rows', async () => {
  const groups = treeGroups();

  const { setup, press, storeChanged, selectedLine } = await mount(
    [],
    { width: 60, height: 8 },
    [],
    groups,
  );

  await press('tab');
  expect(selectedLine()).toContain('Plan title');

  groups.unshift({
    plan: { id: 'demo-3409' as NeedView['id'], title: 'Added plan', state: 'open' },
    slices: [],
  });

  await storeChanged();
  expect(selectedLine()).toContain('Plan title');

  groups.splice(1, 1);
  await storeChanged();

  expect(setup.captureCharFrame()).not.toContain('Plan title');
  expect(selectedLine()).toContain('Added plan');
});

it('opens the row on screen when e arrives in the commit of a reload that removed the selected row', async () => {
  const items = [needView(0, 'A'), needView(1, 'B'), needView(2, 'C')];

  const { edited, press, storeChanged, selectedLine, pressAtNextCommit } = await mount(items, {
    width: 60,
    height: 8,
  });

  await press('j');
  items.splice(1, 1);
  pressAtNextCommit('e');
  await storeChanged();

  expect(selectedLine()).toContain('C');
  expect(edited).toEqual(['demo-3402']);
});

it('moves from the row on screen when j arrives in the commit of a reload', async () => {
  const items = [needView(0, 'A'), needView(1, 'B'), needView(2, 'C'), needView(3, 'D')];

  const { edited, press, storeChanged, selectedLine, pressAtNextCommit } = await mount(items, {
    width: 60,
    height: 8,
  });

  await press('j');
  items.splice(1, 1);
  pressAtNextCommit('j');
  await storeChanged();

  expect(selectedLine()).toContain(' D');

  await press('j');
  await press('e');

  expect(selectedLine()).toContain(' D');
  expect(edited).toEqual(['demo-3403']);
});

it('moves one row for each j that arrives before the next commit', async () => {
  const items = [needView(0, 'A'), needView(1, 'B'), needView(2, 'C')];

  const { storeChanged, selectedLine, pressAtNextCommit } = await mount(items, {
    width: 60,
    height: 8,
  });

  pressAtNextCommit('j', 'j');
  await storeChanged();

  expect(selectedLine()).toContain(' C');
});

it('opens the tree row on screen when e arrives in the commit of a reload that removed the selected row', async () => {
  const groups = treeGroups();
  const [group] = groups;

  group?.slices.push({
    id: 'demo-3404' as NeedView['id'],
    title: 'Other slice',
    state: 'planned',
    pr: null,
    instructions: [],
  });

  const { edited, press, storeChanged, selectedLine, pressAtNextCommit } = await mount(
    [],
    { width: 60, height: 8 },
    [],
    groups,
  );

  await press('tab');
  await press('j');
  expect(selectedLine()).toContain('Slice title');

  group?.slices.splice(0, 1);
  pressAtNextCommit('e');
  await storeChanged();

  expect(selectedLine()).toContain('Other slice');
  expect(edited).toEqual(['demo-3404']);
});

const blocked = (fingerprint: string, claim: string): NeedView => ({
  ...needView(0, 'Same ticket'),
  reason: 'blockedFinding',
  fingerprint,
  claim,
});

it('shows blocked findings of one ticket as different rows and keeps the second selected on reload', async () => {
  const items = [blocked('first', 'First problem'), blocked('second', 'Second problem')];
  const { setup, press, storeChanged, selectedLine } = await mount(items, { width: 80, height: 8 });

  expect(setup.captureCharFrame()).toContain('first  First problem');
  expect(setup.captureCharFrame()).toContain('second  Second problem');

  await press('j');
  expect(selectedLine()).toContain('second');

  await storeChanged();

  expect(selectedLine()).toContain('second');
});
