import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { storeLog } from './store.ts';
import { nodeLogFiles } from './storeHarness.ts';

let store = { root: '' };

beforeEach(async () => {
  store = { root: await mkdtemp(join(tmpdir(), 'tikk-logs-')) };
});

afterEach(async () => {
  await rm(store.root, { recursive: true, force: true });
});

it('stores equal texts as one file with one hash', async () => {
  const first = await storeLog(nodeLogFiles, store, 'all tests passed\n');
  const second = await storeLog(nodeLogFiles, store, 'all tests passed\n');

  expect(first.ok).toBe(true);
  expect(second).toEqual(first);

  const hash = first.ok ? first.value.hash : '';

  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(await readdir(join(store.root, 'logs'))).toEqual([`${hash}.log`]);

  const text = await readFile(join(store.root, 'logs', `${hash}.log`), 'utf8');

  expect(text).toBe('all tests passed\n');
});

it('stores different texts under different hashes', async () => {
  const first = await storeLog(nodeLogFiles, store, 'one');
  const second = await storeLog(nodeLogFiles, store, 'two');

  expect(first.ok && second.ok && first.value.hash !== second.value.hash).toBe(true);
  expect(await readdir(join(store.root, 'logs'))).toHaveLength(2);
});

it('stores a redacted text without the token', async () => {
  const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
  const stored = await storeLog(nodeLogFiles, store, `token=${token} done`);

  expect(stored.ok).toBe(true);

  const hash = stored.ok ? stored.value.hash : '';
  const text = await readFile(join(store.root, 'logs', `${hash}.log`), 'utf8');

  expect(text).toContain('[redacted]');
  expect(text).not.toContain(token);
});

it('returns a failure when the write fails', async () => {
  const stored = await storeLog(
    { ...nodeLogFiles, writeFileExclusive: () => Promise.reject(new Error('disk full')) },
    store,
    'text',
  );

  expect(stored.ok).toBe(false);
});

it('returns a failure when the folder cannot be created', async () => {
  const stored = await storeLog(
    { ...nodeLogFiles, mkdir: () => Promise.reject(new Error('read-only')) },
    store,
    'text',
  );

  expect(stored.ok).toBe(false);
  expect(stored.ok ? '' : stored.reason.message).toContain('read-only');
});
