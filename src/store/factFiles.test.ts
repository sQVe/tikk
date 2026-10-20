import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseFactLine } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import { appendFact, listFactFiles, readFactFile } from './store.ts';
import { nodeFactFiles } from './storeHarness.ts';

let store = { root: '' };

beforeEach(async () => {
  store = { root: await mkdtemp(join(tmpdir(), 'tikk-facts-')) };
});

afterEach(async () => {
  await rm(store.root, { recursive: true, force: true });
});

const releaseAt = (at: string): Fact => ({
  version: 1,
  kind: 'release',
  ticket: 'tk-abcd' as Fact['ticket'],
  at,
  machine: 'laptop',
  holder: 'agent',
});

it('appends a fact to the file of its month in UTC', async () => {
  const late = releaseAt('2026-10-31T23:59:59.000Z');
  const early = releaseAt('2026-11-01T00:00:00.000Z');

  const first = await appendFact(nodeFactFiles, store, 'laptop', late);
  const second = await appendFact(nodeFactFiles, store, 'laptop', early);
  const third = await appendFact(nodeFactFiles, store, 'laptop', late);

  expect(first).toEqual({
    ok: true,
    value: { path: join(store.root, 'facts/laptop/2026-10.jsonl') },
  });

  expect(second).toEqual({
    ok: true,
    value: { path: join(store.root, 'facts/laptop/2026-11.jsonl') },
  });

  expect(third.ok).toBe(true);

  const october = await readFile(join(store.root, 'facts/laptop/2026-10.jsonl'), 'utf8');
  const lines = october.split('\n');

  expect(lines).toHaveLength(3);
  expect(lines[2]).toBe('');
  expect(parseFactLine(lines[0] ?? '')).toEqual({ ok: true, value: late });
});

it('lists fact files from every machine and reads from a byte offset', async () => {
  const fact = releaseAt('2026-10-20T10:00:00.000Z');

  await appendFact(nodeFactFiles, store, 'laptop', fact);
  await appendFact(nodeFactFiles, store, 'desktop', fact);

  const listed = await listFactFiles(nodeFactFiles, store);

  expect(listed.ok && listed.value.map((entry) => entry.path).toSorted()).toEqual([
    join(store.root, 'facts/desktop/2026-10.jsonl'),
    join(store.root, 'facts/laptop/2026-10.jsonl'),
  ]);

  const path = join(store.root, 'facts/laptop/2026-10.jsonl');
  const bytes = await readFactFile(nodeFactFiles, path, 10);
  const whole = await readFile(path);

  expect(bytes).toEqual({ ok: true, value: new Uint8Array(whole.subarray(10)) });
});

it('lists nothing before any fact exists and reports a missing file', async () => {
  expect(await listFactFiles(nodeFactFiles, store)).toEqual({ ok: true, value: [] });

  expect(await readFactFile(nodeFactFiles, join(store.root, 'nope.jsonl'), 0)).toMatchObject({
    ok: false,
    reason: { kind: 'notFound' },
  });
});
