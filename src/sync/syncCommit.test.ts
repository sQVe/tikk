import { expect, it } from 'bun:test';

import { commitStore } from './syncCommit.ts';
import { gitFailure, gitOutput, makeSync } from './syncHarness.ts';

const root = '/store';
const now = 100_000;
const validTicket = '---\nkind: task\ntitle: Valid\nproject: demo\nstatus: open\n---\nBody\n';

const listing =
  (deleted: string[], changed: string[]) =>
  (args: string[]): ReturnType<typeof gitOutput> | undefined => {
    if (args.includes('--deleted')) {
      return gitOutput(deleted.map((path) => `${path}\0`).join(''));
    }

    if (args.includes('--others')) {
      return gitOutput(changed.map((path) => `${path}\0`).join(''));
    }

    return undefined;
  };

const stagedEntries = (fake: ReturnType<typeof makeSync>): string[] =>
  fake.gitCalls.flatMap((call) => {
    const index = call.args.indexOf('update-index');

    return index === -1 ? [] : [call.args.slice(index + 1).join(' ')];
  });

it('stages facts, settled tickets, and deletions, and lists the rest as pending', async () => {
  const fake = makeSync({
    now,
    git: listing(
      ['tickets/demo/gone.md'],
      [
        'tickets/demo/gone.md',
        'facts/laptop/2026-10.jsonl',
        'tikk.json',
        'tickets/demo/settled.md',
        'tickets/demo/fresh.md',
        'tickets/demo/broken.md',
        'tickets/demo/vanished.md',
      ],
    ),
    files: {
      '/store/tickets/demo/settled.md': { text: validTicket, mtimeMs: now - 2000 },
      '/store/tickets/demo/fresh.md': { text: validTicket, mtimeMs: now - 1999 },
      '/store/tickets/demo/broken.md': { text: 'no front matter', mtimeMs: now - 5000 },
    },
  });

  const result = await commitStore(fake.functions, root);

  expect(result).toEqual({
    ok: true,
    value: {
      committed: true,
      pending: ['tickets/demo/fresh.md', 'tickets/demo/broken.md', 'tickets/demo/vanished.md'],
    },
  });

  expect(stagedEntries(fake).toSorted()).toEqual(
    [
      '--add --cacheinfo 100644,blob1,facts/laptop/2026-10.jsonl',
      '--add --cacheinfo 100644,blob3,tickets/demo/settled.md',
      '--add --cacheinfo 100644,blob2,tikk.json',
      '--force-remove -- tickets/demo/gone.md',
    ].toSorted(),
  );

  expect(fake.commands()).toContain('read-tree HEAD');
});

it('makes no commit when only pending tickets changed', async () => {
  const fake = makeSync({
    now,
    git: listing([], ['tickets/demo/fresh.md']),
    files: { '/store/tickets/demo/fresh.md': { text: validTicket, mtimeMs: now } },
  });

  const result = await commitStore(fake.functions, root);

  expect(result).toEqual({
    ok: true,
    value: { committed: false, pending: ['tickets/demo/fresh.md'] },
  });

  expect(stagedEntries(fake)).toEqual([]);
  expect(fake.gitCalls.some((call) => call.args.includes('commit'))).toBe(false);
});

it('fails with the git message when listing changes fails', async () => {
  const fake = makeSync({
    git: (args) => (args.includes('ls-files') ? gitFailure('not a repository') : undefined),
  });

  const result = await commitStore(fake.functions, root);

  expect(result).toEqual({ ok: false, reason: { kind: 'failed', message: 'not a repository' } });
  expect(fake.gitCalls.some((call) => call.args.includes('commit'))).toBe(false);
});

it('fails with the git message when the commit fails', async () => {
  const fake = makeSync({
    git: (args) =>
      args.includes('commit') ? gitFailure('cannot sign') : listing([], ['tikk.json'])(args),
  });

  const result = await commitStore(fake.functions, root);

  expect(result).toEqual({ ok: false, reason: { kind: 'failed', message: 'cannot sign' } });
});

it('commits the bytes it checked when the file changes afterwards', async () => {
  const fake = makeSync({
    now,
    git: listing([], ['tickets/demo/edited.md']),
    files: { '/store/tickets/demo/edited.md': { text: validTicket, mtimeMs: now - 5000 } },
  });

  const checkedRead = fake.functions.readFile;
  let reads = 0;

  const functions = {
    ...fake.functions,
    readFile: async (path: string) => {
      reads += 1;

      return reads === 1 ? checkedRead(path) : 'no front matter here';
    },
  };

  await commitStore(functions, root);

  expect(fake.blobs).toEqual([validTicket]);
});

it('builds the index from HEAD, so staged state from an earlier sync is dropped', async () => {
  const fake = makeSync({ git: listing([], ['tikk.json']) });

  await commitStore(fake.functions, root);

  const commands = fake.commands();

  expect(commands.indexOf('read-tree HEAD')).toBeLessThan(
    commands.findIndex((command) => command.startsWith('update-index')),
  );
});

it('keeps committed alias lines whose ticket is gone from HEAD when a line is appended', async () => {
  const factPath = 'facts/laptop/2026-10.jsonl';
  const aliasLine = '{"version":1,"kind":"alias","ticket":"demo-qqqq","from":"demo-aaaa"}\n';
  const newLine = '{"version":1,"kind":"log"}\n';

  const fake = makeSync({
    git: (args) => {
      if (args.includes('show')) {
        return gitOutput(aliasLine);
      }

      return listing([], [factPath])(args);
    },
    files: { [`/store/${factPath}`]: { text: aliasLine + newLine, mtimeMs: 0 } },
  });

  await commitStore(fake.functions, root);

  expect(fake.blobs).toEqual([aliasLine + newLine]);
});

it('holds back an unplaced alias that sits before the committed lines of a fact file', async () => {
  const factPath = 'facts/laptop/2026-10.jsonl';
  const aliasLine = '{"version":1,"kind":"alias","ticket":"demo-qqqq","from":"demo-aaaa"}\n';
  const committedLine = '{"version":1,"kind":"log"}\n';

  const fake = makeSync({
    git: (args) =>
      args.includes('show') ? gitOutput(committedLine) : listing([], [factPath])(args),
    files: { [`/store/${factPath}`]: { text: aliasLine + committedLine, mtimeMs: 0 } },
  });

  await commitStore(fake.functions, root);

  expect(fake.blobs).toEqual([committedLine]);
});
