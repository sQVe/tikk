import { expect, it } from 'bun:test';

import { readSettings } from './config.ts';
import type { ConfigEffects } from './config.ts';
import { loadBindings } from './remap.ts';
import type { BindingTable, CommandScope } from './tui/tui.tsx';
import { defaultBindings, keysOfAction } from './tui/tui.tsx';

const home = '/home/demo';
const configPath = '/home/demo/.config/tikk/config.json';

const effectsWithText = (text: string): ConfigEffects => ({
  readFile: () => ({ kind: 'text', text }),
});

const loadWith = (effects: ConfigEffects) => loadBindings(readSettings(home, effects), configPath);

const configOf = (value: unknown) => loadWith(effectsWithText(JSON.stringify(value)));

const keysOf = (bindings: BindingTable, scope: CommandScope, id: string): string[] =>
  bindings[scope].filter((binding) => binding.command.id === id).map((binding) => binding.key);

it('moves a command to the key the config names and lists that key in help', () => {
  const loaded = configOf({ keys: { help: ['h'] } });

  expect(keysOf(loaded.bindings, 'global', 'help')).toEqual(['h']);
  expect(keysOfAction(loaded.bindings, 'global', 'help')).toEqual(['h']);
  expect(loaded.messages).toEqual([]);
});

it('uses the default keys when the config file is missing', () => {
  const loaded = loadWith({ readFile: () => ({ kind: 'missing' }) });

  expect(loaded.bindings).toEqual(defaultBindings);
  expect(loaded.messages).toEqual([]);
});

it('reads the config from the home directory', () => {
  const reads: string[] = [];

  const effects: ConfigEffects = {
    readFile: (path) => {
      reads.push(path);

      return { kind: 'missing' };
    },
  };

  loadWith(effects);

  expect(reads).toEqual(['/home/demo/.config/tikk/config.json']);
});

it('names the config path and keeps the defaults when a command id is unknown', () => {
  const loaded = configOf({ keys: { nothingHere: ['x'] } });

  expect(loaded.bindings).toEqual(defaultBindings);
  expect(loaded.messages).toHaveLength(1);
  expect(loaded.messages[0]).toContain(configPath);
  expect(loaded.messages[0]).toContain('keys.nothingHere');
});

it('names the config path and keeps the defaults when a key cannot be read', () => {
  const loaded = configOf({ keys: { help: ['ctrl+'] } });

  expect(loaded.bindings).toEqual(defaultBindings);
  expect(loaded.messages).toHaveLength(1);
  expect(loaded.messages[0]).toContain(configPath);
  expect(loaded.messages[0]).toContain('keys.help "ctrl+"');
});

it('ignores top-level fields it does not use, such as aliases', () => {
  const loaded = configOf({ keys: {}, aliases: { quit: ['exit'] } });

  expect(loaded.bindings).toEqual(defaultBindings);
  expect(loaded.messages).toEqual([]);
});

it('names the config path and keeps the defaults when the file is not JSON', () => {
  const loaded = loadWith(effectsWithText('{ "keys": '));

  expect(loaded.bindings).toEqual(defaultBindings);
  expect(loaded.messages[0]).toContain(configPath);
});

it('refuses a remap that takes Ctrl+C away from quit', () => {
  const loaded = configOf({ keys: { help: ['ctrl+c'] } });

  expect(loaded.bindings).toEqual(defaultBindings);
  expect(loaded.messages).toHaveLength(1);
  expect(loaded.messages[0]).toContain(configPath);
  expect(loaded.messages[0]).toContain('Ctrl+C');
});

it('keeps Ctrl+C on quit when the config moves quit to another key', () => {
  const loaded = configOf({ keys: { quit: ['x'] } });

  expect(keysOf(loaded.bindings, 'global', 'quit')).toEqual(['x', 'ctrl+c']);
});

it('refuses two config entries that use the same key in one layer', () => {
  const loaded = configOf({ keys: { help: ['x'], showMessages: ['x'] } });

  expect(loaded.bindings).toEqual(defaultBindings);
  expect(loaded.messages[0]).toContain(configPath);
  expect(loaded.messages[0]).toContain('keys.help "x" and keys.showMessages "x"');
});

it('refuses two config entries where one key starts the other', () => {
  const loaded = configOf({ keys: { help: ['g'], showMessages: ['gm'] } });

  expect(loaded.bindings).toEqual(defaultBindings);
  expect(loaded.messages[0]).toContain(configPath);
});

it('displaces a default key that a config entry takes in the same layer, with a notice', () => {
  const loaded = configOf({ keys: { selectNext: ['s'] } });

  expect(keysOf(loaded.bindings, 'list', 'switchView')).toEqual([]);

  expect(loaded.messages).toEqual([
    'Key "s" of selectNext replaces the default "s" of switchView in the list layer.',
  ]);
});

it('refuses a key token the keymap cannot read, names the config path, and keeps the defaults', () => {
  const loaded = configOf({ keys: { help: ['<bad>'] } });

  expect(loaded.bindings).toEqual(defaultBindings);
  expect(loaded.messages).toHaveLength(1);
  expect(loaded.messages[0]).toContain(configPath);
  expect(loaded.messages[0]).toContain('keys.help "<bad>"');
});

it('refuses a Ctrl+C key for quit unless Ctrl+C is the whole key', () => {
  for (const key of ['ctrl+cx', 'ctrl+c x']) {
    const loaded = configOf({ keys: { quit: [key] } });

    expect(loaded.bindings).toEqual(defaultBindings);
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.messages[0]).toContain(configPath);
    expect(loaded.messages[0]).toContain('Ctrl+C');
  }
});

it('displaces a default key only in the layer where a config entry conflicts with it', () => {
  const loaded = configOf({ keys: { closeHelp: ['j'] } });

  expect(keysOf(loaded.bindings, 'list', 'selectNext')).toEqual(['j', 'down']);
  expect(keysOf(loaded.bindings, 'help', 'selectNext')).toEqual(['down']);

  expect(loaded.messages).toEqual([
    'Key "j" of closeHelp replaces the default "j" of selectNext in the help layer.',
  ]);
});

it('accepts a key listed twice for quit, and quit still runs on it and on Ctrl+C', () => {
  const loaded = configOf({ keys: { quit: ['x', 'x'] } });

  expect(loaded.messages).toEqual([]);
  expect(keysOf(loaded.bindings, 'global', 'quit')).toEqual(['x', 'ctrl+c']);
});

it('accepts a key listed twice for a command that is not quit', () => {
  const loaded = configOf({ keys: { help: ['h', 'h'] } });

  expect(loaded.messages).toEqual([]);
  expect(keysOf(loaded.bindings, 'global', 'help')).toEqual(['h']);
});

it('accepts a named control key that is not Ctrl+C', () => {
  const loaded = configOf({ keys: { help: ['ctrl+comma'] } });

  expect(loaded.messages).toEqual([]);
  expect(keysOf(loaded.bindings, 'global', 'help')).toEqual(['ctrl+comma']);
});

it('refuses a sequence that starts with Ctrl+C for a command that is not quit', () => {
  const loaded = configOf({ keys: { help: ['ctrl+c x'] } });

  expect(loaded.bindings).toEqual(defaultBindings);
  expect(loaded.messages[0]).toContain('Ctrl+C');
});
