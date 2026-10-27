import { afterEach, expect, it } from 'bun:test';

import { act } from 'react';

import { createTuiFixture, needView, treeGroups } from './tuiHarness.tsx';
import type { TuiFixture } from './tuiHarness.tsx';

let fixture: TuiFixture | undefined;

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

  expect(detail).toMatch(/Title\s+Second/);
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
    .some((line) => /^> demo-3400 .*│ ID\s+demo-3400/.test(line));

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

  expect(frame).toMatch(/Kind\s+Slice/);
  expect(frame).toMatch(/State\s+active/);
});

it('quits on Ctrl+C while the full-screen detail is open', async () => {
  const { press, quits } = await mount([needView(0, 'First')], { width: 80, height: 20 });

  await press('RETURN');
  await press('c', { ctrl: true });

  expect(quits()).toBe(1);
});
