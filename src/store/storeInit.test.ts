import { afterEach, beforeEach, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initStore, openStore } from './store.ts';
import type { StoreInitEffects } from './store.ts';
import { nodeStoreFiles } from './storeHarness.ts';

let base = '';

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'tikk-init-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const effects: StoreInitEffects = {
  ...nodeStoreFiles,
  runGit: async (args) => {
    const process = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const stdout = await new Response(process.stdout).text();
    const code = await process.exited;

    return code === 0
      ? { ok: true, value: stdout }
      : { ok: false, reason: { message: 'git failed' } };
  },
};

it('creates the store once and reports created only the first time', async () => {
  const root = join(base, 'store');
  const first = await initStore(root, effects);
  const second = await initStore(root, effects);

  expect(first).toMatchObject({ ok: true, value: { created: true, store: { root } } });
  expect(second).toMatchObject({ ok: true, value: { created: false, store: { root } } });
  expect(existsSync(join(root, '.git'))).toBe(true);
  expect(await Bun.file(join(root, 'tikk.json')).json()).toEqual({ version: 1 });
});

it('fails to open a store without tikk.json and names tikk init', async () => {
  const result = await openStore(base, effects);

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain('tikk init');
});

it('fails to open a store with an invalid tikk.json and names the file', async () => {
  const configPath = join(base, 'tikk.json');

  await writeFile(configPath, '{"version": 2}');

  const result = await openStore(base, effects);

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain(configPath);
});

it('does not overwrite an invalid tikk.json on init', async () => {
  const configPath = join(base, 'tikk.json');

  await writeFile(configPath, 'nope');

  const result = await initStore(base, effects);

  expect(result.ok).toBe(false);
  expect(await Bun.file(configPath).text()).toBe('nope');
});

it('fails with a typed reason when the store folder cannot be created', async () => {
  const blocker = join(base, 'blocker');

  await writeFile(blocker, 'a file');

  const result = await initStore(join(blocker, 'store'), effects);

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain(blocker);

  expect(await Bun.file(blocker).text()).toBe('a file');
});

it('fails with a typed reason when tikk.json cannot be written', async () => {
  const root = join(base, 'store');

  const result = await initStore(root, {
    ...effects,
    writeFile: () => Promise.reject(new Error('read-only')),
  });

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain('tikk.json');

  expect(existsSync(join(root, 'tikk.json'))).toBe(false);
});
