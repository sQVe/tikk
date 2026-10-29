import { afterEach, expect, it } from 'bun:test';

import { helpWindowOf } from './helpWindow.ts';
import { catalog, defaultBindings } from './tuiCommands.ts';
import {
  commandLabel,
  createTuiFixture,
  noProjects,
  needView,
  projectTree,
} from './tuiHarness.tsx';
import type { TuiFixture } from './tuiHarness.tsx';
import { createTuiSession } from './tuiSession.ts';

let fixture: TuiFixture | undefined;

const mount = async (...args: Parameters<typeof createTuiFixture>): Promise<TuiFixture> => {
  fixture = await createTuiFixture(...args);

  return fixture;
};

const rowsOf = (frame: string): string[] => frame.split('\n');

const lastRowOf = (frame: string): string =>
  rowsOf(frame).findLast((row) => row.trim() !== '') ?? '';

const rowIndexOf = (frame: string, text: string): number =>
  rowsOf(frame).findIndex((row) => row.includes(text));

// The row under the action that shows the given label, where its disabled reason would be.
const rowAfter = (frame: string, id: string): string =>
  rowsOf(frame)[rowIndexOf(frame, commandLabel(id)) + 1] ?? '';

const footerRowOf = (frame: string): string =>
  rowsOf(frame).find((row) => /\d+\D+\d+\D+\d+/.test(row)) ?? '';

const positionOf = (frame: string): number[] =>
  (/(-?\d+)-(-?\d+)\D+(\d+)/.exec(footerRowOf(frame)) ?? []).slice(1).map(Number);

const firstFailureOf = (frame: string): number => Number(/Failure (\d+)\./.exec(frame)?.[1]);

const helpTitlesOf = (): string[] => {
  const session = createTuiSession({
    load: () => Promise.resolve({ ok: true, value: { items: [], reconcileProblems: [] } }),
    loadTree: () => Promise.resolve({ ok: true, value: { current: null, projects: [] } }),
    loadErrors: () => Promise.resolve({ ok: true, value: [] }),
    loadDetail: (rawId) =>
      Promise.resolve({
        ok: false,
        reason: { code: 'notFound', message: `Ticket ${rawId} does not exist.` },
      }),
    edit: () => Promise.resolve({ ok: true, value: undefined }),
    editDesign: () => Promise.resolve({ ok: true, value: undefined }),
    lend: async (run) => ({ ok: true, value: await run() }),
    onChange: () => () => undefined,
    notices: [],
  });

  const window = helpWindowOf(defaultBindings, session.getSnapshot(), 200, 80);

  session.stop();

  return window.lines.flatMap((line) => (line.kind === 'heading' ? [line.text] : []));
};

// Rows between the edit row and the next action's row, so a reason row under edit adds one.
const helpFrameOf = async (rowsDown: number): Promise<string> => {
  const { setup, press } = await mount([], { width: 80, height: 60 }, [], projectTree());

  await press('s');

  for (let step = 0; step < rowsDown; step += 1) {
    await press('j');
  }

  await press('?');

  const frame = setup.captureCharFrame();

  fixture?.cleanup();
  fixture = undefined;

  return frame;
};

const editGapOf = async (rowsDown: number): Promise<number> => {
  const frame = await helpFrameOf(rowsDown);

  return rowIndexOf(frame, commandLabel('openDetail')) - rowIndexOf(frame, commandLabel('edit'));
};

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

it('lists every help command and shows why edit is disabled when no ticket is selected', async () => {
  const { setup, press } = await mount([], { width: 80, height: 44 });

  await press('?');

  const frame = setup.captureCharFrame();
  const listed = catalog.filter((command) => command.hiddenFromHelp !== true);

  expect(listed.length).toBeGreaterThan(0);

  for (const command of listed) {
    expect(frame).toContain(command.label);
  }

  const reason = rowAfter(frame, 'edit');

  expect(reason).not.toContain(commandLabel('openDetail'));
  expect(reason.replace(/[^\p{L}\p{N}]/gu, '')).not.toBe('');
});

it('does not show a disabled reason for edit when a ticket is selected', async () => {
  const { setup, press } = await mount([needView(0, 'First')], { width: 80, height: 40 });

  await press('?');

  expect(rowAfter(setup.captureCharFrame(), 'edit')).toContain(commandLabel('openDetail'));
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

  expect(setup.captureCharFrame()).not.toContain(commandLabel('closeHelp'));
  expect(selectedLine()).toContain('First');

  await press('j');
  expect(selectedLine()).toContain('Second');
});

it('keeps a failed editor run in the message history after the status clears', async () => {
  const outcomes = [
    () => Promise.reject(new Error('The editor crashed.')),
    () => Promise.resolve({ ok: true as const, value: undefined }),
  ];

  const { setup, press } = await mount(
    [needView(0, 'First')],
    { width: 60, height: 12 },
    [],
    noProjects(),
    {
      edit: () => outcomes.shift()?.() ?? Promise.reject(new Error('No more edits.')),
    },
  );

  await press('e');
  await press('e');
  expect(setup.captureCharFrame()).not.toContain('The editor crashed.');

  await press('g');
  await press('m');

  const frame = setup.captureCharFrame();

  expect(rowsOf(frame).some((row) => row.startsWith('>'))).toBe(false);
  expect(frame).toContain('The editor crashed.');

  await press('q');

  expect(setup.captureCharFrame()).not.toContain('The editor crashed.');
});

it('shows that no message arrived yet', async () => {
  const { setup, press, selectedLine } = await mount([needView(0, 'First')], {
    width: 60,
    height: 12,
  });

  await press('g');
  await press('m');

  expect(selectedLine()).toBeUndefined();
  expect(rowsOf(setup.captureCharFrame())[1]?.replace(/[^\p{L}\p{N}]/gu, '')).not.toBe('');
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
  expect(after).toContain(commandLabel('closeMessages'));

  await press('g');
  await press('g');

  expect(setup.captureCharFrame()).toBe(before);
});

// The messages overlay fills every row above the status row, so its rows are the frame minus that row.
const overlayOf = (frame: string, height: number): string =>
  frame
    .split('\n')
    .slice(0, height - 1)
    .join('\n');

// The help row that shows the given key token. A label can be clipped at a narrow width, so the key is searched.
const helpRowWithKey = (frame: string, key: string): string =>
  rowsOf(frame).find((row) => new RegExp(`\\b${key}\\b`).test(row)) ?? '';

it('scrolls a long message history from the newest to the oldest message', async () => {
  let failures = 0;

  const { setup, press } = await mount(
    [needView(0, 'First')],
    { width: 60, height: 8 },
    [],
    noProjects(),
    {
      edit: () => {
        failures += 1;

        return Promise.resolve({
          ok: false,
          reason: { code: 'storeError', message: `Failure ${failures}.` },
        });
      },
    },
  );

  for (let count = 0; count < 8; count += 1) {
    await press('e');
  }

  await press('g');
  await press('m');

  const newest = overlayOf(setup.captureCharFrame(), 8);

  expect(newest).toContain('Failure 8.');
  expect(newest).not.toContain('Failure 1.');

  await press('G');

  const oldest = overlayOf(setup.captureCharFrame(), 8);

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

      if (overlay === 'help') {
        expect(frame).not.toContain(commandLabel('closeHelp'));
      }

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

  expect(frame).toContain('…');
  expect(frame).not.toContain(commandLabel('switchView'));
});

it('drops the close hint from the help footer when the box is too narrow for it', async () => {
  const { setup, press } = await mount([], { width: 30, height: 12 });

  await press('?');

  const footer = footerRowOf(setup.captureCharFrame());

  expect(footer).toMatch(/\bj\b/);
  expect(footer).not.toMatch(/\bq\b/);
  expect(footer).not.toContain('…');
});

it('shows the close hint in the help footer when the box is wide enough', async () => {
  const { setup, press } = await mount([], { width: 80, height: 12 });

  await press('?');

  const footer = footerRowOf(setup.captureCharFrame());

  expect(footer).toMatch(/\bj\b/);
  expect(footer).toMatch(/\bq\b/);
});

it('closes help when ? is pressed again', async () => {
  const { setup, press } = await mount([], { width: 80, height: 44 });

  await press('?');
  expect(setup.captureCharFrame()).toContain(commandLabel('closeHelp'));

  await press('?');
  expect(setup.captureCharFrame()).not.toContain(commandLabel('closeHelp'));
});

it('shows the help key in the status line', async () => {
  const { setup } = await mount([], { width: 80, height: 12 });

  expect(lastRowOf(setup.captureCharFrame())).toMatch(/(^|\s)\?(\s|$)/);
});

it('keeps the status line visible while help is open on an empty list', async () => {
  const { setup, press } = await mount([], { width: 80, height: 12 }, ['STATUS-MARKER']);

  expect(setup.captureCharFrame()).toContain('STATUS-MARKER');

  await press('?');

  expect(setup.captureCharFrame()).toContain('STATUS-MARKER');
});

it('keeps the status line on the bottom row while help is open on an empty list', async () => {
  const { setup, press } = await mount([], { width: 80, height: 12 }, ['STATUS-MARKER']);

  await press('?');

  expect(lastRowOf(setup.captureCharFrame())).toContain('STATUS-MARKER');
});

it('keeps the status line on the bottom row while help is open during a load that has not settled', async () => {
  const { setup, press } = await mount(
    [],
    { width: 80, height: 12 },
    ['STATUS-MARKER'],
    noProjects(),
    {
      load: () => Promise.withResolvers<never>().promise,
    },
  );

  const pending = lastRowOf(setup.captureCharFrame());

  expect(pending.trim()).not.toBe('');

  await press('?');

  expect(lastRowOf(setup.captureCharFrame())).toBe(pending);
});

it('shows the status line on the only row of an 80 by 1 terminal while the list is loading', async () => {
  const { setup } = await mount([], { width: 80, height: 1 }, [], noProjects(), {
    load: () => Promise.withResolvers<never>().promise,
  });

  expect(setup.captureCharFrame().trim()).not.toBe('');
  expect(setup.captureCharFrame()).toContain('?');
});

it('shows each action key as its own token in help at narrow widths', async () => {
  for (const width of [24, 30, 36, 44]) {
    const { setup, press } = await mount([needView(0, 'First')], { width, height: 40 });

    await press('?');

    const row = helpRowWithKey(setup.captureCharFrame(), 'Enter');

    expect(row).toMatch(/\bEnter +\S/);

    fixture?.cleanup();
    fixture = undefined;
  }
});

it('keeps the help footer on one row at narrow widths', async () => {
  for (const width of [24, 30, 36, 44]) {
    const { setup, press } = await mount([], { width, height: 12 });

    await press('?');

    const rows = rowsOf(setup.captureCharFrame());
    const footerAt = rows.findIndex((row) => /\d+-\d+\D+\d+/.test(row));

    expect(footerAt).toBeGreaterThan(-1);
    expect(rows[footerAt + 1] ?? '').not.toMatch(/[A-Za-z0-9]/);

    fixture?.cleanup();
    fixture = undefined;
  }
});

it('shows the position of the visible help rows in an overflowing help box', async () => {
  const { setup, press } = await mount([], { width: 80, height: 12 });

  await press('?');

  const [start, shown, total] = positionOf(setup.captureCharFrame());

  expect(start).toBe(1);
  expect(shown).toBeGreaterThanOrEqual(start ?? 0);
  expect(total).toBeGreaterThan(shown ?? 0);
});

it('lists every action once in help', async () => {
  const { setup, press } = await mount([], { width: 80, height: 44 });

  await press('?');

  const frame = setup.captureCharFrame();

  for (const command of catalog.filter((candidate) => candidate.hiddenFromHelp !== true)) {
    expect(frame.split(command.label)).toHaveLength(2);
  }
});

it('draws the title of every help section', async () => {
  const titles = helpTitlesOf();
  const { setup, press } = await mount([], { width: 80, height: 60 });

  await press('?');

  expect(titles.length).toBeGreaterThan(0);

  for (const title of titles) {
    expect(setup.captureCharFrame()).toContain(title);
  }
});

it('shows a reason under edit in help when the selected row is a project', async () => {
  const onPlan = await editGapOf(2);
  const onProject = await editGapOf(0);

  expect(onProject).toBeGreaterThan(onPlan);
});

it('explains with visible text why edit is disabled for a project row', async () => {
  const frame = await helpFrameOf(0);
  const editAt = rowIndexOf(frame, commandLabel('edit'));
  const reason = rowsOf(frame)[editAt + 1] ?? '';

  expect(reason.replace(/[^\p{L}\p{N}]/gu, '')).not.toBe('');
});

it('consumes a key that misses a pending sequence, so no later listener receives it', async () => {
  const { setup, press } = await mount([needView(0, 'First')], { width: 80, height: 40 });
  const received: string[] = [];

  setup.renderer.keyInput.on('keypress', (event) => {
    received.push(event.name);
  });

  await press('w');
  expect(received).toContain('w');

  received.length = 0;
  await press('g');
  await press('w');

  expect(received).not.toContain('w');
});

it('shows the position of the recent messages in the messages overlay', async () => {
  const { setup, press } = await mount(
    [needView(0, 'First')],
    { width: 60, height: 12 },
    [],
    noProjects(),
    {
      edit: () =>
        Promise.resolve({ ok: false, reason: { code: 'storeError', message: 'x'.repeat(600) } }),
    },
  );

  await press('e');
  await press('g');
  await press('m');

  const [start, shown, total] = positionOf(setup.captureCharFrame());

  expect(start).toBe(1);
  expect(shown).toBeGreaterThanOrEqual(start ?? 0);
  expect(total).toBeGreaterThan(shown ?? 0);
});

it('labels the shifted and control keys in help', async () => {
  const { setup, press } = await mount([], { width: 80, height: 40 });

  await press('?');

  const rows = rowsOf(setup.captureCharFrame());
  const keyRowOf = (label: string) => rows.find((row) => row.includes(label)) ?? '';

  expect(keyRowOf(commandLabel('selectLast'))).toMatch(/(^|\s)G(\s|$)/);
  expect(keyRowOf(commandLabel('quit'))).toContain('Ctrl+C');
  expect(rows.join('\n')).not.toContain('undefined');
});

it('keeps list keys working after ? closes help', async () => {
  const { press, selectedLine } = await mount([needView(0, 'First'), needView(1, 'Second')], {
    width: 80,
    height: 40,
  });

  await press('?');
  await press('?');
  await press('j');

  expect(selectedLine()).toContain('Second');
});

it('moves the messages overlay up one line from its bottom with k', async () => {
  let failures = 0;

  const { setup, press } = await mount(
    [needView(0, 'First')],
    { width: 60, height: 8 },
    [],
    noProjects(),
    {
      edit: () => {
        failures += 1;

        return Promise.resolve({
          ok: false,
          reason: { code: 'storeError', message: `Failure ${failures}.` },
        });
      },
    },
  );

  for (let count = 0; count < 20; count += 1) {
    await press('e');
  }

  await press('g');
  await press('m');
  await press('G');

  const atBottom = firstFailureOf(setup.captureCharFrame());

  await press('k');

  expect(firstFailureOf(setup.captureCharFrame())).toBe(atBottom + 1);
});

it('explains with visible text why open detail is disabled when the list is empty', async () => {
  const { setup, press } = await mount([], { width: 80, height: 40 });

  await press('?');

  const frame = setup.captureCharFrame();
  const openAt = rowIndexOf(frame, commandLabel('openDetail'));
  const reason = rowsOf(frame)[openAt + 1] ?? '';

  expect(reason.replace(/[^\p{L}\p{N}]/gu, '')).not.toBe('');
});

it('shows the position of help rows with a dash between the first and last row', async () => {
  const { setup, press } = await mount([], { width: 80, height: 12 });

  await press('?');

  expect(footerRowOf(setup.captureCharFrame())).toMatch(/\d+-\d+/);
});
