import { afterEach, expect, it } from 'bun:test';

import { loadConfig } from '../src/config/config.ts';
import type { ConfigEffects } from '../src/config/config.ts';
import { createTuiFixture, needView } from '../src/tui/tuiHarness.tsx';
import type { TuiFixture } from '../src/tui/tuiHarness.tsx';

const configPath = '/home/demo/config/tikk/config.json';
const environment = { XDG_CONFIG_HOME: '/home/demo/config' };

let fixture: TuiFixture | undefined;

const mountWithConfig = async (value: unknown): Promise<TuiFixture> => {
  const effects: ConfigEffects = {
    readFile: () => ({ kind: 'text', text: JSON.stringify(value) }),
  };

  const loaded = loadConfig(environment, effects);

  fixture = await createTuiFixture(
    [needView(0, 'First'), needView(1, 'Second')],
    { width: 80, height: 40 },
    [],
    [],
    {},
    loaded.catalog,
    loaded.messages,
  );

  return fixture;
};

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

it('opens help from the remapped key, ignores the default key, and lists the new key', async () => {
  const { setup, press } = await mountWithConfig({ version: 1, keys: { help: ['h'] } });

  await press('?');
  expect(setup.captureCharFrame()).not.toContain('Close help');

  await press('h');
  expect(setup.captureCharFrame()).toContain('Close help');
  expect(setup.captureCharFrame()).toMatch(/h\s+Toggle help/);
});

it('keeps help open when g then q is pressed after closeHelp moves off q, and Ctrl+C still quits', async () => {
  const { setup, press, quits } = await mountWithConfig({
    version: 1,
    keys: { closeHelp: ['x', 'escape'] },
  });

  await press('?');
  await press('g');
  await press('q');

  expect(setup.captureCharFrame()).toContain('Close help');
  expect(quits()).toBe(0);

  await press('c', { ctrl: true });

  expect(quits()).toBe(1);
});

it('shows a config error in the message history and keeps the default keys', async () => {
  const { setup, press } = await mountWithConfig({ version: 1, keys: { nothingHere: ['x'] } });

  await press('?');
  expect(setup.captureCharFrame()).toContain('Close help');
  await press('ESCAPE');

  await press('g');
  await press('m');

  expect(setup.captureCharFrame()).toContain(configPath);
});

it('keeps the defaults and Ctrl+C quitting when a key token cannot be read', async () => {
  const { setup, press, quits } = await mountWithConfig({ version: 1, keys: { help: ['<bad>'] } });

  await press('?');
  expect(setup.captureCharFrame()).toContain('Close help');

  await press('c', { ctrl: true });
  expect(quits()).toBe(1);
});

it('refuses a quit key that uses Ctrl+C inside a sequence and keeps Ctrl+C quitting', async () => {
  const { press, quits } = await mountWithConfig({ version: 1, keys: { quit: ['ctrl+cx'] } });

  await press('c', { ctrl: true });
  expect(quits()).toBe(1);
});

it('lets a remapped help key close help while the list keeps its shared key', async () => {
  const { setup, press, selectedLine } = await mountWithConfig({
    version: 1,
    keys: { closeHelp: ['j'] },
  });

  await press('?');
  await press('j');
  expect(setup.captureCharFrame()).not.toContain('Close help');
  expect(selectedLine()).toContain('First');

  await press('j');
  expect(selectedLine()).toContain('Second');
});

it('closes help with a remapped key that follows g', async () => {
  const { setup, press } = await mountWithConfig({ version: 1, keys: { closeHelp: ['x'] } });

  await press('?');
  await press('g');
  await press('x');

  expect(setup.captureCharFrame()).not.toContain('Close help');
});
