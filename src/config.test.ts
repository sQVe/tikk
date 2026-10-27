import { expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readSettings } from './config.ts';
import type { ConfigEffects } from './config.ts';

const home = '/home/demo';
const configPath = '/home/demo/.config/tikk/config.json';

const effectsWithText = (text: string): ConfigEffects => ({
  readFile: () => ({ kind: 'text', text }),
});

it('reads the file from the home directory', () => {
  const reads: string[] = [];

  readSettings(home, {
    readFile: (path) => {
      reads.push(path);

      return { kind: 'missing' };
    },
  });

  expect(reads).toEqual([configPath]);
});

it('reads the projects, machine, and keys from one file that has no version', () => {
  const text = JSON.stringify({
    machine: 'laptop',
    projects: { 'sqve/tikk': 'tk' },
    keys: { help: ['h'] },
  });

  expect(readSettings(home, effectsWithText(text))).toEqual({
    ok: true,
    value: { machine: 'laptop', projects: { 'sqve/tikk': 'tk' }, keys: { help: ['h'] } },
  });
});

it('returns empty settings when the file is missing', () => {
  expect(readSettings(home, { readFile: () => ({ kind: 'missing' }) })).toEqual({
    ok: true,
    value: { machine: undefined, projects: {}, keys: {} },
  });
});

it('ignores top-level fields it does not use', () => {
  const result = readSettings(home, effectsWithText(JSON.stringify({ aliases: { quit: ['x'] } })));

  expect(result).toEqual({
    ok: true,
    value: { machine: undefined, projects: {}, keys: {} },
  });
});

it('names the file when it is not valid JSON', () => {
  const result = readSettings(home, effectsWithText('{ "keys": '));

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason).toContain(configPath);
});

it('names the file and its shape when a field has the wrong type', () => {
  const result = readSettings(home, effectsWithText('{"projects": []}'));

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason).toContain(configPath);
});

it('names the file when it cannot be read', () => {
  const result = readSettings(home, { readFile: () => ({ kind: 'failed' }) });

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason).toContain(configPath);
});

it('reports a config path that cannot be read as a file, without treating it as missing', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'tikk-home-'));
  const unreadablePath = join(tempHome, '.config', 'tikk', 'config.json');

  try {
    await mkdir(unreadablePath, { recursive: true });

    const result = readSettings(tempHome);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain(unreadablePath);
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});
