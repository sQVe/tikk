import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseProjectName, parseTicketFileName } from '../ticket/ticket.ts';
import { createTicketFile, listTicketFiles, readTicketFile, writeTicketFile } from './store.ts';
import type { TicketFileFunctions } from './store.ts';
import { nodeTicketFiles } from './storeHarness.ts';

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
  const created = await createTicketFile(nodeTicketFiles, { root }, projectOf('tikk'), title, text);

  if (!created.ok) {
    throw new Error(created.reason.message);
  }

  return created.value;
};

it('refuses a write with a stale hash and leaves the file unchanged', async () => {
  const created = await createOne('Stale', 'original');
  const before = await readFile(created.path);
  const result = await writeTicketFile(nodeTicketFiles, created.path, 'stale-hash', 'replacement');

  expect(result).toMatchObject({ ok: false, reason: { kind: 'changedOnDisk' } });
  expect((await readFile(created.path)).equals(before)).toBe(true);
});

it('replaces the text when the hash matches', async () => {
  const created = await createOne('Fresh', 'original');
  const result = await writeTicketFile(nodeTicketFiles, created.path, created.hash, 'replacement');
  const reread = await readTicketFile(nodeTicketFiles, created.path);

  expect(result.ok).toBe(true);
  expect(reread).toMatchObject({ ok: true, value: { text: 'replacement' } });
  expect(reread.ok && result.ok && reread.value.hash === result.value.hash).toBe(true);
});

it('reports notFound for a missing file', async () => {
  const missing = join(root, 'tickets', 'tikk', 'tikk-ab3d-gone.md');

  expect(await readTicketFile(nodeTicketFiles, missing)).toMatchObject({
    ok: false,
    reason: { kind: 'notFound' },
  });

  expect(await writeTicketFile(nodeTicketFiles, missing, 'x', 'y')).toMatchObject({
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
  const listed = await listTicketFiles(nodeTicketFiles, { root });
  const files = listed.ok ? listed.value : [];

  expect(files).toHaveLength(1);
  expect(files[0]).toMatchObject({ path: created.path, size: 4 });
});

it('lists the files of every project', async () => {
  const first = await createOne('Here', 'a');

  const second = await createTicketFile(
    nodeTicketFiles,
    { root },
    projectOf('other'),
    'There',
    'b',
  );

  const listed = await listTicketFiles(nodeTicketFiles, { root });
  const paths = listed.ok ? listed.value.map((entry) => entry.path).toSorted() : [];

  expect(second.ok).toBe(true);
  expect(paths).toEqual([first.path, second.ok ? second.value.path : ''].toSorted());
});

it('creates the ticket with another ID after a create collides with an existing file', async () => {
  const attempts: string[] = [];

  const colliding: TicketFileFunctions = {
    ...nodeTicketFiles,
    writeFileExclusive: async (path, text) => {
      attempts.push(path);

      if (attempts.length === 1) {
        await nodeTicketFiles.writeFileExclusive(path, 'taken by someone else');

        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      }

      await nodeTicketFiles.writeFileExclusive(path, text);
    },
  };

  const created = await createTicketFile(colliding, { root }, projectOf('tikk'), 'Race', 'mine');
  const firstPath = attempts[0] ?? '';

  expect(attempts).toHaveLength(2);
  expect(created).toMatchObject({ ok: true, value: { path: attempts[1] } });
  expect(created.ok && created.value.path !== firstPath).toBe(true);
  expect(await readFile(firstPath, 'utf8')).toBe('taken by someone else');
  expect(await readFile(attempts[1] ?? '', 'utf8')).toBe('mine');
});

it('reports a failure and writes nothing when the create fails for another reason', async () => {
  const failing: TicketFileFunctions = {
    ...nodeTicketFiles,
    writeFileExclusive: () => Promise.reject(new Error('disk full')),
  };

  const created = await createTicketFile(failing, { root }, projectOf('tikk'), 'Full', 'x');
  const listed = await listTicketFiles(nodeTicketFiles, { root });

  expect(created).toMatchObject({ ok: false, reason: { kind: 'failed' } });
  expect(listed).toMatchObject({ ok: true, value: [] });
});
