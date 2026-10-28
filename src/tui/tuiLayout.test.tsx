import { afterEach, expect, it } from 'bun:test';

import { act } from 'react';

import { createTuiFixture, needView, treeGroups } from './tuiHarness.tsx';
import type { TuiFixture } from './tuiHarness.tsx';

let fixture: TuiFixture | undefined;

// The detail pane repeats the selected ticket ID, so its start is the second occurrence.
const detailStartOf = (row: string): number => {
  const first = row.indexOf('demo-3400');

  return row.indexOf('demo-3400', first + 1);
};

const mount = async (...args: Parameters<typeof createTuiFixture>): Promise<TuiFixture> => {
  fixture = await createTuiFixture(...args);

  return fixture;
};

const resize = async (
  setup: TuiFixture['setup'],
  size: { width: number; height: number },
): Promise<void> => {
  await act(async () => {
    setup.resize(size.width, size.height);
    await setup.renderOnce();
  });
};

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

it('opens the full-screen detail with Enter and returns to the same row with Esc at 80 columns', async () => {
  const items = [needView(0, 'First'), needView(1, 'Second'), needView(2, 'Third')];
  const { setup, press, selectedLine } = await mount(items, { width: 80, height: 20 });

  await press('j');
  expect(selectedLine()).toContain('Second');

  await press('RETURN');

  const detail = setup.captureCharFrame();

  expect(detail).toContain('Second');
  expect(detail).not.toContain('First');
  expect(detail).not.toContain('Third');

  await press('ESCAPE');

  expect(setup.captureCharFrame()).toContain('Third');
  expect(selectedLine()).toContain('Second');
});

it('keeps the selected ticket when the terminal shrinks from 120 to 80 columns', async () => {
  const items = [needView(0, 'First'), needView(1, 'Second'), needView(2, 'Third')];
  const { setup, press, selectedLine } = await mount(items, { width: 120, height: 20 });

  await press('j');
  expect(selectedLine()).toContain('Second');

  await resize(setup, { width: 80, height: 20 });

  expect(selectedLine()).toContain('Second');
});

it('shows the list and the detail pane side by side at 120 columns', async () => {
  const items = [needView(0, 'First'), needView(1, 'Second')];
  const { setup } = await mount(items, { width: 120, height: 20 });

  const sideBySide = setup
    .captureCharFrame()
    .split('\n')
    .some((line) => line.startsWith('> demo-3400') && detailStartOf(line) > 0);

  expect(sideBySide).toBe(true);
});

it('moves the list keys at 120 columns after Enter, because the pane already shows the row', async () => {
  const items = [needView(0, 'First'), needView(1, 'Second')];
  const { press, selectedLine } = await mount(items, { width: 120, height: 20 });

  await press('RETURN');
  await press('j');

  expect(selectedLine()).toContain('Second');
});

it('returns to the side-by-side layout when the terminal grows while the detail is open', async () => {
  const items = [needView(0, 'First'), needView(1, 'Second')];
  const { setup, press, selectedLine } = await mount(items, { width: 80, height: 20 });

  await press('RETURN');
  await resize(setup, { width: 120, height: 20 });
  await press('j');

  expect(selectedLine()).toContain('Second');
  expect(setup.captureCharFrame()).toMatch(/\u2502 ID\s+demo-3401/);
});

it('shows the kind and state of a tree row in the detail pane', async () => {
  const { setup, press } = await mount([], { width: 120, height: 20 }, [], treeGroups());

  await press('s');
  await press('j');

  const frame = setup.captureCharFrame();

  expect(frame).toMatch(/Slice\s*$/m);
  expect(frame).toMatch(/active\s*$/m);
});

it('quits on Ctrl+C while the full-screen detail is open', async () => {
  const { press, quits } = await mount([needView(0, 'First')], { width: 80, height: 20 });

  await press('RETURN');
  await press('c', { ctrl: true });

  expect(quits()).toBe(1);
});

it('shows the list and the detail side by side from 90 columns', async () => {
  const items = [needView(0, 'First'), needView(1, 'Second')];
  const { setup, press } = await mount(items, { width: 90, height: 20 });

  await press('j');
  await press('RETURN');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('First');
  expect(frame.split('Second').length - 1).toBeGreaterThanOrEqual(2);
});

it('shows the selected list row and its detail on one line at the right of a wide terminal', async () => {
  const { selectedLine } = await mount([needView(0, 'First')], { width: 120, height: 20 });

  const row = selectedLine() ?? '';
  const detailStart = detailStartOf(row);

  expect(detailStart).toBeGreaterThan(row.indexOf('First'));
  expect(row.slice(detailStart)).toContain('demo-3400');
});

it('opens the full-screen detail with Enter after the terminal shrinks below 90 columns', async () => {
  const items = [needView(0, 'First'), needView(1, 'Second')];
  const { setup, press } = await mount(items, { width: 120, height: 20 });

  await act(async () => {
    setup.resize(80, 20);
    await setup.renderOnce();
  });

  await press('j');
  await press('RETURN');

  expect(setup.captureCharFrame()).toContain('Second');
  expect(setup.captureCharFrame()).not.toContain('First');
});

it('keeps the empty list when Enter is pressed on it', async () => {
  const { setup, press } = await mount([], { width: 60, height: 20 });
  const before = setup.captureCharFrame();

  await press('RETURN');

  expect(setup.captureCharFrame()).toBe(before);
});

it('moves the selection on j when Enter and j arrive in one input burst at 120 columns', async () => {
  const items = [needView(0, 'First'), needView(1, 'Second')];

  const { pressAtNextCommit, selectedLine, storeChanged } = await mount(items, {
    width: 120,
    height: 20,
  });

  pressAtNextCommit('RETURN', 'j');
  await storeChanged();

  expect(selectedLine()).toContain('Second');
});

it('stops widening the detail pane on a very wide terminal', async () => {
  const detailWidthAt = async (width: number): Promise<number> => {
    const { selectedLine } = await mount([needView(0, 'First')], { width, height: 20 });
    const row = selectedLine() ?? '';

    fixture?.cleanup();
    fixture = undefined;

    return row.length - detailStartOf(row);
  };

  expect(await detailWidthAt(300)).toBe(await detailWidthAt(200));
});

it('keeps the status line intact on a one-row terminal when the empty list has loaded', async () => {
  const { setup } = await mount([], { width: 80, height: 1 }, ['STATUS-MARKER']);

  const rows = setup
    .captureCharFrame()
    .split('\n')
    .filter((row) => row.trim() !== '');

  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatch(/^\S+\s+STATUS-MARKER\s/);
});

it('keeps the status line intact on a one-row terminal at 120 columns with a selected ticket', async () => {
  const { setup } = await mount([needView(0, 'First')], { width: 120, height: 1 }, [
    'STATUS-MARKER',
  ]);

  const rows = setup
    .captureCharFrame()
    .split('\n')
    .filter((row) => row.trim() !== '');

  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatch(/^\S+\s+STATUS-MARKER\s/);
  expect(rows[0]).not.toContain('demo-3400');
});

// The pane boundary is the first visible character after the selected row's own text.
const paneBoundaryOf = (row: string, text: string): number => {
  const end = row.indexOf(text) + text.length;

  return end + row.slice(end).search(/\S/);
};

it('shows the list left of the detail, with the list wider than the detail, at 90 columns', async () => {
  const { selectedLine } = await mount([needView(0, 'First')], { width: 90, height: 20 });

  const row = selectedLine() ?? '';
  const boundary = paneBoundaryOf(row, 'First');

  expect(row.slice(boundary)).toContain('demo-3400');
  expect(boundary).toBeGreaterThan(row.length - boundary);
});
