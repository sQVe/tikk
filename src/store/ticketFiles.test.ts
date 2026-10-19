import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseProjectName, parseTicketFileName } from '../ticket/ticket.ts';
import { createTicketFile, listTicketFiles, readTicketFile, writeTicketFile } from './store.ts';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tikk-files-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const projectOf = (name: string) => {
  const parsed = parseProjectName(name);

  if (!parsed.ok) {
    throw new Error('bad project');
  }

  return parsed.value;
};

const createOne = async (title: string, text: string) => {
  const created = await createTicketFile({ root }, projectOf('tikk'), title, text);

  if (!created.ok) {
    throw new Error(created.reason.message);
  }

  return created.value;
};

it('refuses a write with a stale hash and leaves the file unchanged', async () => {
  const created = await createOne('Stale', 'original');
  const before = await readFile(created.path);
  const result = await writeTicketFile(created.path, 'stale-hash', 'replacement');

  expect(result).toMatchObject({ ok: false, reason: { kind: 'changedOnDisk' } });
  expect((await readFile(created.path)).equals(before)).toBe(true);
});

it('replaces the text when the hash matches', async () => {
  const created = await createOne('Fresh', 'original');
  const result = await writeTicketFile(created.path, created.hash, 'replacement');
  const reread = await readTicketFile(created.path);

  expect(result.ok).toBe(true);
  expect(reread).toMatchObject({ ok: true, value: { text: 'replacement' } });
  expect(reread.ok && result.ok && reread.value.hash === result.value.hash).toBe(true);
});

it('reports notFound for a missing file', async () => {
  const missing = join(root, 'tickets', 'tikk', 'tikk-ab3d-gone.md');

  expect(await readTicketFile(missing)).toMatchObject({ ok: false, reason: { kind: 'notFound' } });

  expect(await writeTicketFile(missing, 'x', 'y')).toMatchObject({
    ok: false,
    reason: { kind: 'notFound' },
  });
});

it('creates tickets with different IDs and parsable file names', async () => {
  const first = await createOne('Same title', 'a');
  const second = await createOne('Same title', 'b');

  expect(first.id).not.toBe(second.id);

  for (const created of [first, second]) {
    const fileName = created.path.split('/').pop() ?? '';
    const parsed = parseTicketFileName(fileName, projectOf('tikk'));

    expect(parsed).toMatchObject({ ok: true, value: { id: created.id, slug: 'same-title' } });
    expect(created.path).toBe(join(root, 'tickets', 'tikk', fileName));
  }
});

it('lists the created files with their size', async () => {
  const created = await createOne('Listed', 'four');
  const listed = await listTicketFiles({ root });
  const files = listed.ok ? listed.value : [];

  expect(files).toHaveLength(1);
  expect(files[0]).toMatchObject({ path: created.path, size: 4 });
});
