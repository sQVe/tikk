import { afterEach, expect, it } from 'bun:test';

import { readSettings } from '../src/config.ts';
import type { ConfigEffects } from '../src/config.ts';
import { loadBindings } from '../src/remap.ts';
import type { TuiEffects } from '../src/tui/tui.tsx';
import { commandLabel, createTuiFixture, noProjects, needView } from '../src/tui/tuiHarness.tsx';
import type { TuiFixture } from '../src/tui/tuiHarness.tsx';

const rowsOfFrame = (frame: string): string[] => frame.split('\n');

const home = '/home/demo';
const configPath = '/home/demo/.config/tikk/config.json';

let fixture: TuiFixture | undefined;

const defaultSize = { width: 80, height: 40 };

const mountWithConfig = async (
  value: unknown,
  size = defaultSize,
  overrides: Partial<TuiEffects> = {},
): Promise<TuiFixture> => {
  const effects: ConfigEffects = {
    readFile: () => ({ kind: 'text', text: JSON.stringify(value) }),
  };

  const loaded = loadBindings(readSettings(home, effects), configPath);

  fixture = await createTuiFixture(
    [needView(0, 'First'), needView(1, 'Second')],
    size,
    [],
    noProjects(),
    overrides,
    loaded.bindings,
    loaded.messages,
  );

  return fixture;
};

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

it('opens help from the remapped key, ignores the default key, and lists the new key', async () => {
  const { setup, press } = await mountWithConfig({ keys: { help: ['h'] } });

  await press('?');
  expect(setup.captureCharFrame()).not.toContain(commandLabel('closeHelp'));

  await press('h');
  expect(setup.captureCharFrame()).toContain(commandLabel('closeHelp'));
  expect(setup.captureCharFrame()).toMatch(/h\s+Toggle help/);
});

it('keeps help open when g then q is pressed after closeHelp moves off q, and Ctrl+C still quits', async () => {
  const { setup, press, quits } = await mountWithConfig({
    keys: { closeHelp: ['x', 'escape'] },
  });

  await press('?');
  await press('g');
  await press('q');

  expect(setup.captureCharFrame()).toContain(commandLabel('closeHelp'));
  expect(quits()).toBe(0);

  await press('c', { ctrl: true });

  expect(quits()).toBe(1);
});

it('shows a config error in the message history and keeps the default keys', async () => {
  const { setup, press } = await mountWithConfig({ keys: { nothingHere: ['x'] } });

  await press('?');
  expect(setup.captureCharFrame()).toContain(commandLabel('closeHelp'));
  await press('ESCAPE');

  await press('g');
  await press('m');

  expect(setup.captureCharFrame()).toContain(configPath);
});

it('keeps the defaults and Ctrl+C quitting when a key token cannot be read', async () => {
  const { setup, press, quits } = await mountWithConfig({ keys: { help: ['<bad>'] } });

  await press('?');
  expect(setup.captureCharFrame()).toContain(commandLabel('closeHelp'));

  await press('c', { ctrl: true });
  expect(quits()).toBe(1);
});

it('refuses a quit key that uses Ctrl+C inside a sequence and keeps Ctrl+C quitting', async () => {
  const { press, quits } = await mountWithConfig({ keys: { quit: ['ctrl+cx'] } });

  await press('c', { ctrl: true });
  expect(quits()).toBe(1);
});

it('lets a remapped help key close help while the list keeps its shared key', async () => {
  const { setup, press, selectedLine } = await mountWithConfig({
    keys: { closeHelp: ['j'] },
  });

  await press('?');
  await press('j');
  expect(setup.captureCharFrame()).not.toContain(commandLabel('closeHelp'));
  expect(selectedLine()).toContain('First');

  await press('j');
  expect(selectedLine()).toContain('Second');
});

it('closes help with a remapped key that follows g', async () => {
  const { setup, press } = await mountWithConfig({ keys: { closeHelp: ['x'] } });

  await press('?');
  await press('g');
  await press('x');

  expect(setup.captureCharFrame()).not.toContain(commandLabel('closeHelp'));
});

it('quits on a key listed twice for quit, and on Ctrl+C', async () => {
  const { press, quits } = await mountWithConfig({ keys: { quit: ['x', 'x'] } });

  await press('x');
  expect(quits()).toBe(1);

  await press('c', { ctrl: true });
  expect(quits()).toBe(2);
});

it('opens help on a key listed twice for help', async () => {
  const { setup, press } = await mountWithConfig({ keys: { help: ['h', 'h'] } });

  await press('h');

  expect(setup.captureCharFrame()).toContain(commandLabel('closeHelp'));
});

it('quits on Ctrl+C after g when quit is remapped to a two-key sequence, and runs the sequence', async () => {
  const { press, quits } = await mountWithConfig({ keys: { quit: ['xy'] } });

  await press('g');
  await press('c', { ctrl: true });
  expect(quits()).toBe(1);

  await press('x');
  await press('y');
  expect(quits()).toBe(2);
});

it('quits on Ctrl+C after g when closeHelp is remapped to a two-key sequence', async () => {
  const { press, quits } = await mountWithConfig({ keys: { closeHelp: ['xy'] } });

  await press('?');
  await press('g');
  await press('c', { ctrl: true });

  expect(quits()).toBe(1);
});

it('shows the remapped close key in the help footer', async () => {
  const { setup, press } = await mountWithConfig(
    { keys: { closeHelp: ['x'] } },
    { width: 80, height: 12 },
  );

  await press('?');

  const footer = rowsOfFrame(setup.captureCharFrame()).find((row) => /\d+\D+\d+\D+\d+/.test(row));

  expect(footer).toMatch(/\bx\b/);
  expect(footer).not.toMatch(/\bq\b/);
});

it('leaves g then m to the message history when a list key is remapped to m', async () => {
  const outcomes = [
    () => Promise.reject(new Error('Editor failed for the demo.')),
    () => Promise.resolve({ ok: true as const, value: undefined }),
  ];

  const { setup, press, selectedLine } = await mountWithConfig(
    { keys: { selectNext: ['m'] } },
    defaultSize,
    { edit: () => outcomes.shift()?.() ?? Promise.reject(new Error('No more edits.')) },
  );

  await press('e');
  await press('e');
  await press('g');
  await press('m');

  expect(setup.captureCharFrame()).toContain('Editor failed for the demo.');

  await press('ESCAPE');

  expect(selectedLine()).toContain('First');
});

it('opens help on e and runs no edit when help is remapped to e, with a notice', async () => {
  const { setup, press, edited } = await mountWithConfig(
    { keys: { help: ['e'] } },
    { width: 120, height: 40 },
  );

  await press('e');

  expect(setup.captureCharFrame()).toContain(commandLabel('closeHelp'));
  expect(edited).toEqual([]);

  await press('ESCAPE');
  await press('g');
  await press('m');

  expect(setup.captureCharFrame()).toContain(
    'Key "e" of help replaces the default "e" of edit in the list layer.',
  );
});

it('runs selectNext on g when a list remap takes g', async () => {
  const { press, selectedLine } = await mountWithConfig({ keys: { selectNext: ['g'] } });

  expect(selectedLine()).toContain('First');

  await press('g');

  expect(selectedLine()).toContain('Second');
});

it('shows every key of a remapped action in the status line', async () => {
  const { setup } = await mountWithConfig({ keys: { help: ['h', 'x'] } });

  const status = rowsOfFrame(setup.captureCharFrame()).findLast((row) => row.trim() !== '') ?? '';

  expect(status).toMatch(/\bh\b/);
  expect(status).toMatch(/\bx\b/);
});

it('closes help with q without quitting', async () => {
  const { setup, press, quits } = await mountWithConfig({});

  await press('?');
  await press('q');

  expect(setup.captureCharFrame()).not.toContain(commandLabel('closeHelp'));
  expect(quits()).toBe(0);
});

it('keeps the label of an action without keys when it fits the help box exactly', async () => {
  const label = commandLabel('selectFirst');

  const { setup, press } = await mountWithConfig(
    { keys: { selectFirst: [] } },
    { width: label.length + 8, height: 40 },
  );

  await press('?');

  expect(setup.captureCharFrame()).toContain(commandLabel('selectFirst'));
});

it('shows two simple keys of one action as separate keys in help', async () => {
  const { setup, press } = await mountWithConfig({ keys: { help: ['h', 'x'] } });

  await press('h');

  const row =
    rowsOfFrame(setup.captureCharFrame()).find((line) => line.includes(commandLabel('help'))) ?? '';

  expect(row).toMatch(/\bh\b/);
  expect(row).toMatch(/\bx\b/);
  expect(row).not.toMatch(/\bhx\b/);
});
