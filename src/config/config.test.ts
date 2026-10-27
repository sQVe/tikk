import { expect, it } from 'bun:test';

import type { Command } from '../tui/tui.tsx';
import { catalog, keyNamesOf } from '../tui/tui.tsx';
import { loadConfig } from './config.ts';
import type { ConfigEffects } from './config.ts';

const configPath = '/home/demo/config/tikk/config.json';
const environment = { XDG_CONFIG_HOME: '/home/demo/config' };

const effectsWithText = (text: string): ConfigEffects => ({
  readFile: () => ({ kind: 'text', text }),
});

const configOf = (value: unknown) =>
  loadConfig(environment, effectsWithText(JSON.stringify(value)));

const keysOf = (commands: readonly Command[], id: string): string[] => [
  ...(commands.find((command) => command.id === id)?.keys ?? []),
];

it('moves a command to the key the config names and lists that key in help', () => {
  const loaded = configOf({ version: 1, keys: { help: ['h'] } });

  expect(keysOf(loaded.catalog, 'help')).toEqual(['h']);
  expect(keyNamesOf(loaded.catalog, 'help')).toEqual(['h']);
  expect(loaded.messages).toEqual([]);
});

it('uses the default keys when the config file is missing', () => {
  const loaded = loadConfig(environment, { readFile: () => ({ kind: 'missing' }) });

  expect(loaded.catalog).toEqual(catalog);
  expect(loaded.messages).toEqual([]);
});

it('reads the config from HOME when XDG_CONFIG_HOME is not set', () => {
  const reads: string[] = [];

  const effects: ConfigEffects = {
    readFile: (path) => {
      reads.push(path);

      return { kind: 'missing' };
    },
  };

  loadConfig({ HOME: '/home/demo' }, effects);

  expect(reads).toEqual(['/home/demo/.config/tikk/config.json']);
});

it('names the config path and keeps the defaults when a command id is unknown', () => {
  const loaded = configOf({ version: 1, keys: { nothingHere: ['x'] } });

  expect(loaded.catalog).toEqual(catalog);
  expect(loaded.messages).toHaveLength(1);
  expect(loaded.messages[0]).toContain(configPath);
  expect(loaded.messages[0]).toContain('keys.nothingHere');
});

it('names the config path and keeps the defaults when a key cannot be read', () => {
  const loaded = configOf({ version: 1, keys: { help: ['ctrl+'] } });

  expect(loaded.catalog).toEqual(catalog);
  expect(loaded.messages).toHaveLength(1);
  expect(loaded.messages[0]).toContain(configPath);
  expect(loaded.messages[0]).toContain('keys.help "ctrl+"');
});

it('names the config path and keeps the defaults when the file has an unknown field', () => {
  const loaded = configOf({ version: 1, keys: {}, aliases: { quit: ['exit'] } });

  expect(loaded.catalog).toEqual(catalog);
  expect(loaded.messages[0]).toContain(configPath);
});

it('names the config path and keeps the defaults when the file is not JSON', () => {
  const loaded = loadConfig(environment, effectsWithText('{ "version": '));

  expect(loaded.catalog).toEqual(catalog);
  expect(loaded.messages[0]).toContain(configPath);
});

it('refuses a remap that takes Ctrl+C away from quit', () => {
  const loaded = configOf({ version: 1, keys: { help: ['ctrl+c'] } });

  expect(loaded.catalog).toEqual(catalog);
  expect(loaded.messages).toHaveLength(1);
  expect(loaded.messages[0]).toContain(configPath);
  expect(loaded.messages[0]).toContain('Ctrl+C');
});

it('keeps Ctrl+C on quit when the config moves quit to another key', () => {
  const loaded = configOf({ version: 1, keys: { quit: ['x'] } });

  expect(keysOf(loaded.catalog, 'quit')).toEqual(['x', 'ctrl+c']);
});

it('refuses two config entries that use the same key in one layer', () => {
  const loaded = configOf({ version: 1, keys: { help: ['x'], showMessages: ['x'] } });

  expect(loaded.catalog).toEqual(catalog);
  expect(loaded.messages[0]).toContain(configPath);
  expect(loaded.messages[0]).toContain('keys.help "x" and keys.showMessages "x"');
});

it('refuses two config entries where one key starts the other', () => {
  const loaded = configOf({ version: 1, keys: { help: ['g'], showMessages: ['gm'] } });

  expect(loaded.catalog).toEqual(catalog);
  expect(loaded.messages[0]).toContain(configPath);
});

it('displaces a default key that a config entry takes in the same layer, with a notice', () => {
  const loaded = configOf({ version: 1, keys: { selectNext: ['s'] } });

  expect(keysOf(loaded.catalog, 'switchView')).toEqual([]);

  expect(loaded.messages).toEqual([
    'Key "s" of selectNext replaces the default "s" of switchView in the list layer.',
  ]);
});

it('refuses a key token the keymap cannot read, names the config path, and keeps the defaults', () => {
  const loaded = configOf({ version: 1, keys: { help: ['<bad>'] } });

  expect(loaded.catalog).toEqual(catalog);
  expect(loaded.messages).toHaveLength(1);
  expect(loaded.messages[0]).toContain(configPath);
  expect(loaded.messages[0]).toContain('keys.help "<bad>"');
});

it('refuses a Ctrl+C key for quit unless Ctrl+C is the whole key', () => {
  for (const key of ['ctrl+cx', 'ctrl+c x']) {
    const loaded = configOf({ version: 1, keys: { quit: [key] } });

    expect(loaded.catalog).toEqual(catalog);
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.messages[0]).toContain(configPath);
    expect(loaded.messages[0]).toContain('Ctrl+C');
  }
});

it('displaces a default key only in the layer where a config entry conflicts with it', () => {
  const loaded = configOf({ version: 1, keys: { closeHelp: ['j'] } });

  expect(keysOf(loaded.catalog, 'selectNext')).toEqual(['j', 'down']);

  expect(loaded.messages).toEqual([
    'Key "j" of closeHelp replaces the default "j" of selectNext in the help layer.',
  ]);
});
