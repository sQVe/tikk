import { expect, it } from 'bun:test';

import { footerOf, helpWindowOf } from './helpWindow.ts';
import { defaultBindings, expandBindings } from './tuiCommands.ts';
import { createTuiSession } from './tuiSession.ts';
import type { TuiSnapshot } from './tuiSession.ts';

const snapshotOf = async (): Promise<TuiSnapshot> => {
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

  const snapshot = session.getSnapshot();

  session.stop();

  return snapshot;
};

const bindingsWith = (keys: Record<string, string[]>) =>
  expandBindings((command) =>
    (keys[command.id] ?? command.keys).map((key) => ({
      key,
      user: keys[command.id] !== undefined,
      sequenceExit: false,
    })),
  );

const tallHeight = 200;

it('fills the space above the status line with the help box when the rows overflow', async () => {
  const snapshot = await snapshotOf();
  const height = 12;
  const window = helpWindowOf(defaultBindings, snapshot, height, 60);

  expect(window.overflows).toBe(true);
  expect(window.boxHeight).toBe(height - 2);
  expect(window.viewportRows).toBe(height - 5);
  expect(window.maximumTop).toBe(window.lines.length - window.viewportRows);
});

it('overflows when the rows are one row more than the box holds', async () => {
  const snapshot = await snapshotOf();
  const lineCount = helpWindowOf(defaultBindings, snapshot, tallHeight, 60).lines.length;

  expect(helpWindowOf(defaultBindings, snapshot, lineCount + 3, 60).overflows).toBe(true);
});

it('does not overflow when the rows fill the box exactly', async () => {
  const snapshot = await snapshotOf();
  const lineCount = helpWindowOf(defaultBindings, snapshot, tallHeight, 60).lines.length;
  const window = helpWindowOf(defaultBindings, snapshot, lineCount + 4, 60);

  expect(window.overflows).toBe(false);
  expect(window.viewportRows).toBe(lineCount);
});

it('starts the help rows with a heading and separates sections with a blank row', async () => {
  const snapshot = await snapshotOf();
  const { lines } = helpWindowOf(defaultBindings, snapshot, tallHeight, 60);
  const nextHeadingAt = lines.findIndex((line, index) => index > 0 && line.kind === 'heading');

  expect(lines[0]?.kind).toBe('heading');
  expect(lines[nextHeadingAt - 1]).toMatchObject({ kind: 'row', keys: '', label: '' });
});

it('shows no scroll hint without a scroll key and no close hint without a close key', () => {
  const footer = footerOf(bindingsWith({ selectNext: [], selectPrevious: [] }), '1-3 of 9', 60);
  const closeless = footerOf(bindingsWith({ closeHelp: [] }), '1-3 of 9', 60);

  expect(footer).not.toMatch(/(^|[^\w])[jk]([^\w]|$)/);

  expect(
    footerOf(
      bindingsWith({ selectNext: [], selectPrevious: [], closeHelp: [] }),
      '1-3 of 9',
      60,
    ).trim(),
  ).toBe('1-3 of 9');

  expect(closeless).not.toMatch(/\bq\b/);
  expect(closeless).not.toContain('undefined');
});

it('drops the close hint as soon as the footer no longer fits the box', () => {
  const position = '1-3 of 9';
  const fullWidth = footerOf(defaultBindings, position, 1000).length;

  expect(footerOf(defaultBindings, position, fullWidth)).toMatch(/\bq\b/);
  expect(footerOf(defaultBindings, position, fullWidth - 1)).not.toMatch(/\bq\b/);
});

it('keeps the scroll hint when it fits exactly and keeps the position when no hint fits', () => {
  expect(footerOf(defaultBindings, '1-3 of 9', 20)).toMatch(/\bj\/k\b/);
  expect(footerOf(defaultBindings, '1-3 of 9', 4)).toContain('1-');
});
