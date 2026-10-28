import { afterEach, expect, it } from 'bun:test';

import { createTuiFixture, needView } from './tuiHarness.tsx';
import type { TuiFixture } from './tuiHarness.tsx';

let fixture: TuiFixture | undefined;

const mount = async (...args: Parameters<typeof createTuiFixture>): Promise<TuiFixture> => {
  fixture = await createTuiFixture(...args);

  return fixture;
};

const strayError = {
  path: '/store/tickets/demo/demo-3499-broken.md',
  id: 'demo-3499',
  message: 'Bad front matter.',
};

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

it('puts a file error with no ticket row in the message history and counts it in the status line', async () => {
  const { setup, press } = await mount([needView(0, 'First')], { width: 120, height: 12 }, [], [], {
    loadErrors: () => Promise.resolve({ ok: true, value: [strayError] }),
  });

  expect(setup.captureCharFrame()).toContain('1 file error');

  await press('g');
  await press('m');

  expect(setup.captureCharFrame()).toContain(`${strayError.path}: ${strayError.message}`);
});

it('does not repeat a file error in the message history when the store changes again', async () => {
  const { setup, press, storeChanged } = await mount(
    [needView(0, 'First')],
    { width: 120, height: 12 },
    [],
    [],
    { loadErrors: () => Promise.resolve({ ok: true, value: [strayError] }) },
  );

  await storeChanged();
  await press('g');
  await press('m');

  const frame = setup.captureCharFrame();
  const occurrences = frame.split(strayError.path).length - 1;

  expect(occurrences).toBe(1);
});

it('shows the path and parse error in the detail pane of the row with that ticket ID', async () => {
  const error = { path: '/s/demo-3400-first.md', id: 'demo-3400', message: 'Bad front matter.' };

  const { setup } = await mount([needView(0, 'First')], { width: 120, height: 12 }, [], [], {
    loadErrors: () => Promise.resolve({ ok: true, value: [error] }),
  });

  const frame = setup.captureCharFrame();

  expect(frame).toMatch(/File\s+\/s\/demo-3400-first\.md/);
  expect(frame).toMatch(/Error\s+Bad front matter\./);
  expect(frame).not.toContain('file error');
});

it('keeps an error of ticket demo-3467-abcd out of the detail of demo-3467 and counts it as its own error', async () => {
  const error = {
    path: '/s/demo/demo-3467-abcd-broken.md',
    id: 'demo-3467-abcd',
    message: 'Bad front matter.',
  };

  const { setup, press } = await mount(
    [needView(67, 'Target')],
    { width: 120, height: 12 },
    [],
    [],
    {
      loadErrors: () => Promise.resolve({ ok: true, value: [error] }),
    },
  );

  expect(setup.captureCharFrame()).toContain('1 file error');
  expect(setup.captureCharFrame()).not.toContain(error.path);

  await press('g');
  await press('m');

  expect(setup.captureCharFrame()).toContain(`${error.path}: ${error.message}`);
});

it('publishes an error that first matched a row to the history once that row is gone, and not again', async () => {
  const items = [needView(0, 'First')];

  const error = {
    path: '/s/demo/demo-3400-first.md',
    id: 'demo-3400',
    message: 'Bad front matter.',
  };

  const { setup, press, storeChanged } = await mount(items, { width: 120, height: 12 }, [], [], {
    loadErrors: () => Promise.resolve({ ok: true, value: [error] }),
  });

  expect(setup.captureCharFrame()).not.toContain('1 file error');

  items.splice(0);
  await storeChanged();

  expect(setup.captureCharFrame()).toContain('1 file error');

  await storeChanged();
  await storeChanged();
  await press('g');
  await press('m');

  const frame = setup.captureCharFrame();

  expect(frame.split(error.path).length - 1).toBe(1);
  expect(frame).toContain(error.message);
});
