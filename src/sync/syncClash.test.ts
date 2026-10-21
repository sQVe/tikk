import { expect, it } from 'bun:test';

import { resolveIdClashes } from './syncClash.ts';
import { gitFailure, gitOutput, makeSync } from './syncHarness.ts';

const root = '/store';
const factPath = '/store/facts/fake/2026-10.jsonl';

// Each file's adding commit time, or no entry for a file no commit added yet.
const clashingStore = (
  addedTimes: Record<string, string>,
  fileNames: string[],
  extra: Parameters<typeof makeSync>[0] = {},
) =>
  makeSync({
    ...extra,
    files: { [factPath]: { text: 'alias line\n', mtimeMs: 0 }, ...extra.files },
    folders: { '/store/tickets': ['demo'], '/store/tickets/demo': fileNames },
    git: (args) => {
      const reply = extra.git?.(args);

      if (reply !== undefined) {
        return reply;
      }

      if (args.includes('log')) {
        const path = args.at(-1) ?? '';

        return gitOutput(addedTimes[path.split('/').at(-1) ?? ''] ?? '');
      }

      return undefined;
    },
  });

const movedFiles = (fake: ReturnType<typeof makeSync>): string[] =>
  fake.renames.map(([from]) => from.split('/').at(-1) ?? '');

it('renames the file added later even when its name sorts first', async () => {
  const fake = clashingStore({ 'demo-aaaa-b.md': '100', 'demo-aaaa-a.md': '200' }, [
    'demo-aaaa-a.md',
    'demo-aaaa-b.md',
  ]);

  const result = await resolveIdClashes(fake.functions, root);

  expect(result.ok).toBe(true);
  expect(movedFiles(fake)).toEqual(['demo-aaaa-a.md']);
});

it('renames the file with the later name when both were added at the same time', async () => {
  const fake = clashingStore({ 'demo-aaaa-a.md': '100', 'demo-aaaa-b.md': '100' }, [
    'demo-aaaa-b.md',
    'demo-aaaa-a.md',
  ]);

  await resolveIdClashes(fake.functions, root);

  expect(movedFiles(fake)).toEqual(['demo-aaaa-b.md']);
});

it('renames a file that no commit added, and keeps the committed one', async () => {
  const fake = clashingStore({ 'demo-aaaa-z.md': '100' }, ['demo-aaaa-a.md', 'demo-aaaa-z.md']);

  await resolveIdClashes(fake.functions, root);

  expect(movedFiles(fake)).toEqual(['demo-aaaa-a.md']);
});

const twoTickets = (options: Parameters<typeof makeSync>[0] = {}) =>
  clashingStore(
    { 'demo-aaaa-a.md': '100', 'demo-aaaa-b.md': '200' },
    ['demo-aaaa-a.md', 'demo-aaaa-b.md'],
    options,
  );

const stagedEntries = (fake: ReturnType<typeof makeSync>): string[] =>
  fake.gitCalls.flatMap((call) =>
    call.args.includes('update-index')
      ? [call.args.slice(call.args.indexOf('update-index') + 1).join(' ')]
      : [],
  );

it('commits a tracked rename from HEAD together with its alias fact in one commit', async () => {
  const fake = twoTickets();

  const result = await resolveIdClashes(fake.functions, root);
  const commits = fake.commands().filter((command) => command.startsWith('commit'));

  expect(result.ok && result.value.moves).toEqual([
    { from: 'tickets/demo/demo-aaaa-b.md', to: 'tickets/demo/demo-zzzz-b.md', tracked: true },
  ]);

  expect(commits).toHaveLength(1);

  expect(stagedEntries(fake)).toEqual([
    '--add --cacheinfo 100644,,tickets/demo/demo-zzzz-b.md',
    '--force-remove -- tickets/demo/demo-aaaa-b.md',
    '--add --cacheinfo 100644,blob1,facts/fake/2026-10.jsonl',
  ]);

  expect(fake.blobs).toEqual(['alias line\n']);
});

it('reuses the new ID of an earlier alias and writes no second alias fact', async () => {
  const fake = twoTickets({
    aliases: [{ from: 'demo-aaaa', to: 'demo-qqqq', path: 'facts/fake/2026-10.jsonl' }],
  });

  const result = await resolveIdClashes(fake.functions, root);

  expect(result.ok && result.value.aliases.map((alias) => String(alias.to))).toEqual(['demo-qqqq']);
  expect(fake.aliasWrites()).toBe(0);
});

it('does not reuse an alias whose new ID a file already uses', async () => {
  const fake = clashingStore(
    { 'demo-aaaa-a.md': '100', 'demo-aaaa-b.md': '200' },
    ['demo-aaaa-a.md', 'demo-aaaa-b.md', 'demo-qqqq-c.md'],
    {
      files: { [factPath]: { text: 'alias line\n', mtimeMs: 0 } },
      aliases: [{ from: 'demo-aaaa', to: 'demo-qqqq', path: 'facts/fake/2026-10.jsonl' }],
    },
  );

  const result = await resolveIdClashes(fake.functions, root);

  expect(result.ok && result.value.aliases.map((alias) => String(alias.to))).toEqual(['demo-zzzz']);
  expect(fake.aliasWrites()).toBe(1);
});

it('leaves a file no commit added out of the clash commit', async () => {
  const fake = clashingStore({ 'demo-aaaa-a.md': '100' }, ['demo-aaaa-a.md', 'demo-aaaa-b.md'], {
    files: { [factPath]: { text: 'alias line\n', mtimeMs: 0 } },
  });

  const result = await resolveIdClashes(fake.functions, root);

  expect(result.ok && result.value.moves.map((move) => move.tracked)).toEqual([false]);
  expect(stagedEntries(fake)).toEqual(['--add --cacheinfo 100644,blob1,facts/fake/2026-10.jsonl']);
});

const oldPath = '/store/tickets/demo/demo-aaaa-b.md';
const newPath = '/store/tickets/demo/demo-zzzz-b.md';

const withTicketBytes = (extra: Parameters<typeof makeSync>[0]) =>
  twoTickets({
    ...extra,
    files: { [oldPath]: { text: 'renamed ticket bytes', mtimeMs: 0 } },
  });

it('keeps an editor save at the old path when the clash commit fails', async () => {
  const fake: ReturnType<typeof makeSync> = withTicketBytes({
    git: (args) => {
      if (!args.includes('commit')) {
        return undefined;
      }

      fake.disk.set(oldPath, { text: 'saved by the editor', mtimeMs: 0 });

      return gitFailure('hook refused');
    },
  });

  const result = await resolveIdClashes(fake.functions, root);

  expect(result.ok).toBe(false);
  expect(fake.disk.get(oldPath)?.text).toBe('saved by the editor');
  expect(fake.disk.get(newPath)?.text).toBe('renamed ticket bytes');
});

it('keeps a save that appears at the old path between the rollback check and the restore', async () => {
  const fake = withTicketBytes({
    git: (args) => (args.includes('commit') ? gitFailure('hook refused') : undefined),
    beforeLink: (path, disk) => {
      disk.set(path, { text: 'saved late', mtimeMs: 0 });
    },
  });

  const result = await resolveIdClashes(fake.functions, root);

  expect(result.ok).toBe(false);
  expect(fake.disk.get(oldPath)?.text).toBe('saved late');
  expect(fake.disk.get(newPath)?.text).toBe('renamed ticket bytes');
});

it('puts the renamed ticket back at the old path when nothing was saved there', async () => {
  const fake = withTicketBytes({
    git: (args) => (args.includes('commit') ? gitFailure('hook refused') : undefined),
  });

  await resolveIdClashes(fake.functions, root);

  expect(fake.disk.get(oldPath)?.text).toBe('renamed ticket bytes');
  expect(fake.disk.has(newPath)).toBe(false);
});
