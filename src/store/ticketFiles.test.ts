import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { parseProjectName, parseTicketFileName, parseTicketId } from '../ticket/ticket.ts';
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

it.each(['project folder', 'ticket file'])(
  'fails the list when a %s cannot be checked',
  async (target) => {
    const created = await createOne('Hidden', 'a');
    const deniedPath = target === 'project folder' ? join(root, 'tickets', 'tikk') : created.path;

    const denyingFiles: TicketFileFunctions = {
      ...nodeTicketFiles,
      stat: async (path) => {
        if (path === deniedPath) {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }

        return nodeTicketFiles.stat(path);
      },
    };

    const listed = await listTicketFiles(denyingFiles, { root });

    expect(listed).toMatchObject({ ok: false, reason: { kind: 'failed' } });
    expect(!listed.ok && listed.reason.message).toContain(deniedPath);
  },
);

it('skips an entry that vanishes between list and check', async () => {
  const created = await createOne('Kept', 'a');
  const vanished = join(root, 'tickets', 'gone');

  const vanishingFiles: TicketFileFunctions = {
    ...nodeTicketFiles,
    readdir: async (directory) => {
      const names = await nodeTicketFiles.readdir(directory);

      return directory === join(root, 'tickets') ? [...names, 'gone'] : names;
    },
    stat: async (path) => {
      if (path === vanished) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }

      return nodeTicketFiles.stat(path);
    },
  };

  const listed = await listTicketFiles(vanishingFiles, { root });
  const paths = listed.ok ? listed.value.map((entry) => entry.path) : [];

  expect(paths).toEqual([created.path]);
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

it('keeps a file another writer created when the exclusive create fails', async () => {
  const otherText = 'another writer';
  let otherPath = '';

  const racing: TicketFileFunctions = {
    ...nodeTicketFiles,
    writeFileExclusive: async (path) => {
      otherPath = path;
      await nodeTicketFiles.writeFile(path, otherText);

      throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
    },
  };

  const created = await createTicketFile(racing, { root }, projectOf('tikk'), 'Race', 'mine');

  expect(created).toMatchObject({ ok: false, reason: { kind: 'failed' } });
  expect(await readFile(otherPath, 'utf8')).toBe(otherText);
});

const codeError = (code: string) => Object.assign(new Error(code), { code });

const throwing = (thrown: unknown) => (): never => {
  throw thrown;
};

const sequence = (...values: string[]) => {
  let index = 0;

  return () => {
    const value = values[index] ?? values.at(-1) ?? '';

    index += 1;

    return value;
  };
};

it('lists no files when the tickets folder does not exist', async () => {
  expect(await listTicketFiles(nodeTicketFiles, { root })).toEqual({ ok: true, value: [] });
});

it('fails the list with the folder in the message when the tickets folder cannot be read', async () => {
  const denied: TicketFileFunctions = {
    ...nodeTicketFiles,
    readdir: () => Promise.reject(codeError('EACCES')),
  };

  const listed = await listTicketFiles(denied, { root });

  expect(listed.ok).toBe(false);
  expect(!listed.ok && listed.reason.kind).toBe('failed');
  expect(!listed.ok && listed.reason.message).toContain(join(root, 'tickets'));
});

it('fails the list with the folder in the message when a project folder cannot be read', async () => {
  await createOne('Hidden', 'a');

  const projectFolder = join(root, 'tickets', 'tikk');

  const denied: TicketFileFunctions = {
    ...nodeTicketFiles,
    readdir: async (directory) => {
      if (directory === projectFolder) {
        throw codeError('EACCES');
      }

      return nodeTicketFiles.readdir(directory);
    },
  };

  const listed = await listTicketFiles(denied, { root });

  expect(listed.ok).toBe(false);
  expect(!listed.ok && listed.reason.message).toContain(projectFolder);
});

it('lists only regular markdown files', async () => {
  const created = await createOne('Kept', 'a');
  const projectFolder = join(root, 'tickets', 'tikk');

  await writeFile(join(projectFolder, 'notes.txt'), 'text');
  await mkdir(join(projectFolder, 'folder.md'));
  await writeFile(join(root, 'tickets', 'stray.md'), 'text');

  const listed = await listTicketFiles(nodeTicketFiles, { root });

  expect(listed).toMatchObject({ ok: true, value: [{ path: created.path }] });
  expect(listed.ok && listed.value).toHaveLength(1);
});

it('skips a project file that vanishes between list and check', async () => {
  const created = await createOne('Kept', 'a');
  const vanished = join(root, 'tickets', 'tikk', 'gone.md');

  const vanishing: TicketFileFunctions = {
    ...nodeTicketFiles,
    readdir: async (directory) => {
      const names = await nodeTicketFiles.readdir(directory);

      return directory === join(root, 'tickets', 'tikk') ? [...names, 'gone.md'] : names;
    },
    stat: async (path) => {
      if (path === vanished) {
        throw codeError('ENOENT');
      }

      return nodeTicketFiles.stat(path);
    },
  };

  const listed = await listTicketFiles(vanishing, { root });

  expect(listed.ok && listed.value.map((entry) => entry.path)).toEqual([created.path]);
});

it.each([
  ['null', null],
  ['a text', 'ENOENT'],
  ['an object that only has a code', { code: 'ENOENT' }],
])('fails the list instead of throwing when readdir throws %s', async (_name, thrown) => {
  const odd: TicketFileFunctions = { ...nodeTicketFiles, readdir: throwing(thrown) };
  const listed = await listTicketFiles(odd, { root });

  expect(listed).toMatchObject({ ok: false, reason: { kind: 'failed' } });
});

it('fails to read with the path in the message when the read is denied', async () => {
  const created = await createOne('Hidden', 'a');

  const denied: TicketFileFunctions = {
    ...nodeTicketFiles,
    readFile: () => Promise.reject(codeError('EACCES')),
  };

  const read = await readTicketFile(denied, created.path);

  expect(read.ok).toBe(false);
  expect(!read.ok && read.reason.kind).toBe('failed');
  expect(!read.ok && read.reason.message).toContain(created.path);
});

it('picks another ID when a file with the generated ID and another slug exists', async () => {
  const folder = join(root, 'tickets', 'tikk');

  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'tikk-3a4b-older-title.md'), 'older');

  const files: TicketFileFunctions = {
    ...nodeTicketFiles,
    randomIdSuffix: sequence('3a4b', '3a4c'),
  };

  const created = await createTicketFile(files, { root }, projectOf('tikk'), 'Newer title', 'new');

  expect(created).toMatchObject({ ok: true, value: { id: 'tikk-3a4c' } });

  expect((await readdir(folder)).toSorted()).toEqual([
    'tikk-3a4b-older-title.md',
    'tikk-3a4c-newer-title.md',
  ]);
});

it('skips an ID whose name a folder in the project folder already uses', async () => {
  const folder = join(root, 'tickets', 'tikk');

  await mkdir(join(folder, 'tikk-3a4b'), { recursive: true });

  const files: TicketFileFunctions = {
    ...nodeTicketFiles,
    randomIdSuffix: sequence('3a4b', '3a4c'),
  };

  const created = await createTicketFile(files, { root }, projectOf('tikk'), 'Folder clash', 'x');

  expect(created).toMatchObject({ ok: true, value: { id: 'tikk-3a4c' } });
});

it('gives up with the project in the message after 100 colliding attempts', async () => {
  const attempts: string[] = [];

  const colliding: TicketFileFunctions = {
    ...nodeTicketFiles,
    writeFileExclusive: (path) => {
      attempts.push(path);

      return Promise.reject(codeError('EEXIST'));
    },
  };

  const created = await createTicketFile(colliding, { root }, projectOf('tikk'), 'Busy', 'x');

  expect(attempts).toHaveLength(100);
  expect(created.ok).toBe(false);
  expect(!created.ok && created.reason.kind).toBe('failed');
  expect(!created.ok && created.reason.message).toContain('tikk');
});

it('gives up with the project in the message after 100 taken IDs', async () => {
  const folder = join(root, 'tickets', 'tikk');

  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'tikk-3a4b-older.md'), 'older');

  const writes: string[] = [];

  const files: TicketFileFunctions = {
    ...nodeTicketFiles,
    randomIdSuffix: () => '3a4b',
    writeFileExclusive: (path) => {
      writes.push(path);

      return Promise.resolve();
    },
  };

  const created = await createTicketFile(files, { root }, projectOf('tikk'), 'Busy', 'x');

  expect(writes).toEqual([]);
  expect(created.ok).toBe(false);
  expect(!created.ok && created.reason.message).toContain('tikk');
});

it('tries a create once and names the path when it fails for another reason', async () => {
  const attempts: string[] = [];

  const failing: TicketFileFunctions = {
    ...nodeTicketFiles,
    writeFileExclusive: (path) => {
      attempts.push(path);

      return Promise.reject(new Error('disk full'));
    },
  };

  const created = await createTicketFile(failing, { root }, projectOf('tikk'), 'Full', 'x');

  expect(attempts).toHaveLength(1);
  expect(!created.ok && created.reason.message).toContain(attempts[0] ?? 'missing');
});

it('fails with the folder in the message when the project folder cannot be created', async () => {
  const writes: string[] = [];

  const denied: TicketFileFunctions = {
    ...nodeTicketFiles,
    mkdir: () => Promise.reject(codeError('EACCES')),
    writeFileExclusive: (path) => {
      writes.push(path);

      return Promise.resolve();
    },
  };

  const created = await createTicketFile(denied, { root }, projectOf('tikk'), 'Title', 'x');

  expect(writes).toHaveLength(0);
  expect(created.ok).toBe(false);
  expect(!created.ok && created.reason.message).toContain(join(root, 'tickets', 'tikk'));
});

it('fails the create when the project folder cannot be listed', async () => {
  const denied: TicketFileFunctions = {
    ...nodeTicketFiles,
    readdir: () => Promise.reject(codeError('EACCES')),
  };

  const created = await createTicketFile(denied, { root }, projectOf('tikk'), 'Title', 'x');

  expect(created.ok).toBe(false);
  expect(!created.ok && created.reason.message).toContain(join(root, 'tickets', 'tikk'));
});

it('throws when the generated ID is not valid', async () => {
  const bad: TicketFileFunctions = { ...nodeTicketFiles, randomIdSuffix: () => '!!!!' };

  const outcome = await createTicketFile(bad, { root }, projectOf('tikk'), 'Title', 'x').then(
    () => 'resolved',
    () => 'rejected',
  );

  expect(outcome).toBe('rejected');
});

it.each([
  ['the temporary write', 'writeFile'],
  ['the rename', 'rename'],
] as const)('keeps the file and removes the temporary file when %s fails', async (_name, step) => {
  const created = await createOne('Keep', 'original');
  const removed: string[] = [];

  const failing: TicketFileFunctions = {
    ...nodeTicketFiles,
    [step]: async (...args: string[]) => {
      if (step === 'writeFile') {
        await nodeTicketFiles.writeFile(args[0] ?? '', 'partial');
      }

      throw new Error('disk full');
    },
    unlink: async (path) => {
      removed.push(path);
      await nodeTicketFiles.unlink(path);
    },
  };

  const result = await writeTicketFile(failing, created.path, created.hash, 'replacement');
  const remaining = await readdir(join(root, 'tickets', 'tikk'));

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.kind).toBe('failed');
  expect(!result.ok && result.reason.message).toContain(created.path);
  expect(removed).toHaveLength(1);
  expect(remaining).toEqual([basename(created.path)]);
  expect(await readFile(created.path, 'utf8')).toBe('original');
});

it('still reports the write failure when removing the temporary file fails', async () => {
  const created = await createOne('Keep', 'original');

  const failing: TicketFileFunctions = {
    ...nodeTicketFiles,
    writeFile: () => Promise.reject(new Error('disk full')),
    unlink: () => Promise.reject(new Error('cannot remove')),
  };

  const result = await writeTicketFile(failing, created.path, created.hash, 'replacement');

  expect(result).toMatchObject({ ok: false, reason: { kind: 'failed' } });
});

it('does not give a new ticket an ID that an alias already names as its new ID', async () => {
  const suffixes = ['qqqq', 'zzzz'];

  const files: TicketFileFunctions = {
    ...nodeTicketFiles,
    randomIdSuffix: () => suffixes.shift() ?? 'zzzz',
  };

  const reservedId = parseTicketId('tikk-qqqq');

  if (!reservedId.ok) {
    throw new Error(reservedId.reason.message);
  }

  const created = await createTicketFile(
    files,
    { root },
    projectOf('tikk'),
    'Reserved',
    'x',
    new Set([reservedId.value]),
  );

  expect(created).toMatchObject({ ok: true, value: { id: 'tikk-zzzz' } });
});
