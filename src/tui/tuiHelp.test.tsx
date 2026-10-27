import { afterEach, expect, it } from 'bun:test';

import { catalog } from './tuiCommands.ts';
import { createTuiFixture, needView } from './tuiHarness.tsx';
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

it('lists every help command and shows why edit is disabled when no ticket is selected', async () => {
  const { setup, press } = await mount([], { width: 80, height: 40 });

  await press('?');

  const frame = setup.captureCharFrame();
  const listed = catalog.filter((command) => command.hiddenFromHelp !== true);

  expect(listed.length).toBeGreaterThan(0);

  for (const command of listed) {
    expect(frame).toContain(command.label);
  }

  expect(frame).toContain('No ticket is selected.');
});

it('does not show a disabled reason for edit when a ticket is selected', async () => {
  const { setup, press } = await mount([needView(0, 'First')], { width: 80, height: 40 });

  await press('?');

  expect(setup.captureCharFrame()).not.toContain('No ticket is selected.');
});

it('closes help with escape and lets list keys move the selection again', async () => {
  const { setup, press, selectedLine } = await mount(
    [needView(0, 'First'), needView(1, 'Second')],
    { width: 80, height: 40 },
  );

  await press('?');
  await press('j');
  expect(selectedLine()).toContain('First');

  await press('ESCAPE');

  expect(setup.captureCharFrame()).not.toContain('Close help');
  expect(selectedLine()).toContain('First');

  await press('j');
  expect(selectedLine()).toContain('Second');
});

it('keeps a failed editor run in the message history after the status clears', async () => {
  const outcomes = [
    () => Promise.reject(new Error('The editor crashed.')),
    () => Promise.resolve({ ok: true as const, value: undefined }),
  ];

  const { setup, press } = await mount([needView(0, 'First')], { width: 60, height: 12 }, [], [], {
    edit: () => outcomes.shift()?.() ?? Promise.reject(new Error('No more edits.')),
  });

  await press('e');
  await press('e');
  expect(setup.captureCharFrame()).not.toContain('The editor crashed.');

  await press('g');
  await press('m');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('Messages');
  expect(frame).toContain('The editor crashed.');

  await press('q');

  expect(setup.captureCharFrame()).not.toContain('The editor crashed.');
});

it('shows that no message arrived yet', async () => {
  const { setup, press } = await mount([needView(0, 'First')], { width: 60, height: 12 });

  await press('g');
  await press('m');

  expect(setup.captureCharFrame()).toContain('No messages yet');
});

it('moves to the last and first row with G and gg', async () => {
  const { press, selectedLine } = await mount(
    [needView(0, 'First'), needView(1, 'Second'), needView(2, 'Third')],
    { width: 60, height: 12 },
  );

  await press('G');
  expect(selectedLine()).toContain('Third');

  await press('g');
  await press('g');
  expect(selectedLine()).toContain('First');
});

it('scrolls the help overlay with list movement keys', async () => {
  const { setup, press } = await mount([], { width: 60, height: 10 });

  await press('?');

  const before = setup.captureCharFrame();

  await press('G');

  const after = setup.captureCharFrame();

  expect(after).not.toBe(before);
  expect(after).toContain('Close messages');

  await press('g');
  await press('g');

  expect(setup.captureCharFrame()).toBe(before);
});

it('scrolls a long message history from the newest to the oldest message', async () => {
  let failures = 0;

  const { setup, press } = await mount([needView(0, 'First')], { width: 60, height: 8 }, [], [], {
    edit: () => {
      failures += 1;

      return Promise.resolve({
        ok: false,
        reason: { code: 'storeError', message: `Failure ${failures}.` },
      });
    },
  });

  for (let count = 0; count < 8; count += 1) {
    await press('e');
  }

  await press('g');
  await press('m');

  const newest = setup.captureCharFrame();

  expect(newest).toContain('Failure 8.');
  expect(newest).not.toContain('Failure 1.');

  await press('G');

  const oldest = setup.captureCharFrame();

  expect(oldest).toContain('Failure 1.');
  expect(oldest).not.toContain('Failure 8.');
});

const openOverlay = async (overlay: 'none' | 'help' | 'messages', press: TuiFixture['press']) => {
  if (overlay === 'help') {
    await press('?');
  }

  if (overlay === 'messages') {
    await press('g');
    await press('m');
  }
};

for (const overlay of ['none', 'help', 'messages'] as const) {
  it(`quits with Ctrl+C after g when the overlay is ${overlay}`, async () => {
    const { press, quits } = await mount([needView(0, 'First')], { width: 80, height: 40 });

    await openOverlay(overlay, press);
    await press('g');
    await press('c', { ctrl: true });

    expect(quits()).toBe(1);
  });
}

for (const overlay of ['help', 'messages'] as const) {
  for (const closeKey of ['q', 'ESCAPE']) {
    it(`closes ${overlay} with ${closeKey} after g, without quitting`, async () => {
      const { setup, press, quits, selectedLine } = await mount(
        [needView(0, 'First'), needView(1, 'Second')],
        { width: 80, height: 40 },
      );

      await openOverlay(overlay, press);
      await press('g');
      await press(closeKey);

      const frame = setup.captureCharFrame();

      expect(frame).not.toContain(overlay === 'help' ? 'Close help' : 'No messages yet');
      expect(quits()).toBe(0);

      await press('j');
      expect(selectedLine()).toContain('Second');
    });
  }
}

it('clips a help label that does not fit the box with an ellipsis', async () => {
  const { setup, press } = await mount([], { width: 30, height: 40 });

  await press('?');

  const frame = setup.captureCharFrame();

  expect(frame).toContain('Switch between home…');
  expect(frame).not.toContain('Switch between home and tree');
});

it('drops the close hint from the help footer when the box is too narrow for it', async () => {
  const { setup, press } = await mount([], { width: 30, height: 12 });

  await press('?');

  const frame = setup.captureCharFrame();

  expect(frame).toMatch(/of \d+\s+j\/k scroll/);
  expect(frame).not.toContain('q close');
});

it('shows the close hint in the help footer when the box is wide enough', async () => {
  const { setup, press } = await mount([], { width: 80, height: 12 });

  await press('?');

  expect(setup.captureCharFrame()).toContain('j/k scroll');
  expect(setup.captureCharFrame()).toContain('q close');
});
