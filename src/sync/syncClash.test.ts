import { expect, it } from 'bun:test';

import { resolveIdClashes } from './syncClash.ts';
import { gitFailure, gitOutput, makeSync } from './syncHarness.ts';

type FakeSyncOptions = NonNullable<Parameters<typeof makeSync>[0]>;
type GitHandler = NonNullable<FakeSyncOptions['git']>;

const root = '/store';
const oldPath = '/store/tickets/demo/demo-aaaa-b.md';
const newPath = '/store/tickets/demo/demo-zzzz-b.md';
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
    folders: { '/store/tickets': ['demo'], '/store/tickets/demo': fileNames, ...extra.folders },
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
    '--add --cacheinfo 100644,abc123,tickets/demo/demo-zzzz-b.md',
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

const strictCommands = {
  logOlder: 'log --diff-filter=A --format=%ct -- tickets/demo/demo-aaaa-a.md',
  logNewer: 'log --diff-filter=A --format=%ct -- tickets/demo/demo-aaaa-b.md',
  head: 'rev-parse --verify --quiet HEAD',
  readTree: 'read-tree HEAD',
  blob: 'ls-tree HEAD -- tickets/demo/demo-aaaa-b.md',
  addMove: 'update-index --add --cacheinfo 100644,abc123,tickets/demo/demo-zzzz-b.md',
  removeMove: 'update-index --force-remove -- tickets/demo/demo-aaaa-b.md',
  addFact: 'update-index --add --cacheinfo 100644,blob1,facts/fake/2026-10.jsonl',
};

const strictReplies: Record<string, string> = {
  [strictCommands.logOlder]: '900\n',
  [strictCommands.logNewer]: '1000\n2000\n',
  [strictCommands.head]: '',
  [strictCommands.readTree]: '',
  [strictCommands.blob]: '100644 blob abc123\ttickets/demo/demo-aaaa-b.md\n',
  [strictCommands.addMove]: '',
  [strictCommands.removeMove]: '',
  [strictCommands.addFact]: '',
};

const commandOf = (args: string[]): string => {
  const index = args.indexOf('-C');

  return args.slice(index + 2).join(' ');
};

// Answers only the exact Git calls of a clash, so a changed argument fails the sync.
const strictClashGit =
  (failOn?: string): GitHandler =>
  (args) => {
    const command = commandOf(args);

    const isCommit = command.startsWith('commit --quiet -m ');

    const failsHere = command === failOn;
    const failsCommit = failOn === 'commit' && isCommit;

    if (failsHere || failsCommit) {
      return gitFailure('injected failure');
    }

    if (command === 'config user.email') {
      return gitOutput('me@example.com\n');
    }

    if (isCommit) {
      return gitOutput('');
    }

    const reply = strictReplies[command];

    return reply === undefined ? gitFailure(`unexpected git call: ${command}`) : gitOutput(reply);
  };

const strictStore = (failOn?: string, extra: FakeSyncOptions = {}) =>
  makeSync({
    ...extra,
    files: {
      [factPath]: { text: 'alias line\n', mtimeMs: 0 },
      [oldPath]: { text: 'ticket bytes', mtimeMs: 0 },
      ...extra.files,
    },
    folders: {
      '/store/tickets': ['demo'],
      '/store/tickets/demo': ['demo-aaaa-a.md', 'demo-aaaa-b.md'],
    },
    git: extra.git ?? strictClashGit(failOn),
    now: Date.parse('2026-10-05T10:00:00.000Z'),
  });

const nonConfigCommands = (fake: ReturnType<typeof makeSync>): string[] =>
  fake.commands().filter((command) => command !== 'config user.email');

it('runs exactly the expected Git calls for a tracked clash, and commits with signing off', async () => {
  const fake = strictStore();

  const result = await resolveIdClashes(fake.functions, root);
  const commit = fake.gitCalls.find((call) => call.args.includes('commit'));

  expect(result.ok).toBe(true);

  expect(nonConfigCommands(fake).filter((command) => !command.startsWith('commit'))).toEqual([
    strictCommands.logOlder,
    strictCommands.logNewer,
    strictCommands.head,
    strictCommands.readTree,
    strictCommands.blob,
    strictCommands.addMove,
    strictCommands.removeMove,
    strictCommands.addFact,
  ]);

  expect(commit?.args.slice(0, 2)).toEqual(['-c', 'commit.gpgsign=false']);

  expect(fake.aliasRecords).toEqual([
    { ticket: 'demo-zzzz', from: 'demo-aaaa', at: '2026-10-05T10:00:00.000Z' },
  ]);
});

it.each([
  strictCommands.readTree,
  strictCommands.blob,
  strictCommands.addMove,
  strictCommands.removeMove,
  strictCommands.addFact,
])(
  'fails with the Git error, commits nothing, and restores the file when %s fails',
  async (command) => {
    const fake = strictStore(command);

    const result = await resolveIdClashes(fake.functions, root);

    expect(result).toEqual({ ok: false, reason: { kind: 'failed', message: 'injected failure' } });
    expect(fake.commands().some((entry) => entry.startsWith('commit'))).toBe(false);
    expect(fake.disk.has(oldPath)).toBe(true);
    expect(fake.disk.has(newPath)).toBe(false);
  },
);

it('fails and commits nothing when HEAD has no entry for a tracked move', async () => {
  const fake = strictStore(undefined, {
    git: (args) =>
      commandOf(args) === strictCommands.blob ? gitOutput('') : strictClashGit()(args),
  });

  const result = await resolveIdClashes(fake.functions, root);

  expect(result.ok).toBe(false);
  expect(fake.commands().some((entry) => entry.startsWith('commit'))).toBe(false);
  expect(fake.disk.has(oldPath)).toBe(true);
  expect(fake.disk.has(newPath)).toBe(false);
});

it('fails, and restores the file, when the commit fails', async () => {
  const fake = strictStore('commit');

  const result = await resolveIdClashes(fake.functions, root);

  expect(result).toEqual({ ok: false, reason: { kind: 'failed', message: 'injected failure' } });
  expect(fake.disk.get(oldPath)?.text).toBe('ticket bytes');
  expect(fake.disk.has(newPath)).toBe(false);
});

it('fails and commits nothing when the alias fact cannot be staged', async () => {
  const fake = strictStore(undefined, { blobFails: 'blob refused' });

  const result = await resolveIdClashes(fake.functions, root);

  expect(result).toEqual({ ok: false, reason: { kind: 'failed', message: 'blob refused' } });
  expect(fake.commands().some((entry) => entry.startsWith('commit'))).toBe(false);
});

it('fails and commits nothing when the alias fact file cannot be read', async () => {
  const fake = strictStore();

  const functions = {
    ...fake.functions,
    readFile: (path: string) =>
      path === factPath ? Promise.reject(new Error('gone')) : fake.functions.readFile(path),
  };

  const result = await resolveIdClashes(functions, root);

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.kind).toBe('failed');
  expect(fake.commands().some((entry) => entry.startsWith('commit'))).toBe(false);
});

it('fails before moving anything when the alias fact cannot be written', async () => {
  const fake = strictStore(undefined, { appendAliasFails: 'no space' });

  const result = await resolveIdClashes(fake.functions, root);

  expect(result).toEqual({ ok: false, reason: { kind: 'failed', message: 'no space' } });
  expect(fake.renames).toEqual([]);
  expect(fake.commands().some((entry) => entry.startsWith('commit'))).toBe(false);
});

it('fails, and commits nothing, when the file cannot be renamed', async () => {
  const fake = strictStore(undefined, { renameFails: true });

  const result = await resolveIdClashes(fake.functions, root);

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.kind).toBe('failed');
  expect(fake.commands().some((entry) => entry.startsWith('commit'))).toBe(false);
});

it('gives up after 100 tries when every new ID is taken, and changes nothing', async () => {
  const fake = strictStore(undefined, { suffixes: ['aaaa'] });

  const result = await resolveIdClashes(fake.functions, root);

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.kind).toBe('failed');
  expect(fake.suffixCalls()).toBe(100);
  expect(fake.renames).toEqual([]);
  expect(fake.aliasWrites()).toBe(0);
});

it('skips an invalid or taken ID and uses the next free one', async () => {
  const fake = twoTickets({ suffixes: ['', 'aaaa', 'qqqq'] });

  const result = await resolveIdClashes(fake.functions, root);

  expect(result.ok && result.value.aliases.map((alias) => String(alias.to))).toEqual(['demo-qqqq']);
});

it('gives each of two clashing files its own new ID', async () => {
  const fake = clashingStore(
    { 'demo-aaaa-a.md': '100', 'demo-aaaa-b.md': '200', 'demo-aaaa-c.md': '300' },
    ['demo-aaaa-a.md', 'demo-aaaa-b.md', 'demo-aaaa-c.md'],
    { suffixes: ['qqqq', 'qqqq', 'rrrr'] },
  );

  const result = await resolveIdClashes(fake.functions, root);

  expect(result.ok && result.value.aliases.map((alias) => String(alias.to)).toSorted()).toEqual([
    'demo-qqqq',
    'demo-rrrr',
  ]);
});

it.each([
  ['another old ID', { from: 'demo-bbbb', to: 'demo-qqqq' }],
  ['another project', { from: 'demo-aaaa', to: 'other-qqqq' }],
  ['an ID that does not parse', { from: 'demo-aaaa', to: 'demo-' }],
  ['an ID that a file uses', { from: 'demo-aaaa', to: 'demo-aaaa' }],
])('does not reuse an alias with %s', async (_name, alias) => {
  const fake = twoTickets({ aliases: [{ ...alias, path: 'facts/fake/2026-10.jsonl' }] });

  const result = await resolveIdClashes(fake.functions, root);

  expect(result.ok && result.value.aliases.map((entry) => String(entry.to))).toEqual(['demo-zzzz']);
  expect(fake.aliasWrites()).toBe(1);
});

it('renames the clashing files of every project', async () => {
  const fake = makeSync({
    folders: {
      '/store/tickets': ['demo', 'work'],
      '/store/tickets/demo': ['demo-aaaa-a.md', 'demo-aaaa-b.md'],
      '/store/tickets/work': ['work-aaaa-a.md', 'work-aaaa-b.md'],
    },
    git: (args) =>
      args.includes('log')
        ? gitOutput((args.at(-1) ?? '').endsWith('-a.md') ? '100' : '200')
        : undefined,
  });

  const result = await resolveIdClashes(fake.functions, root);

  expect(result.ok && result.value.aliases.map((alias) => String(alias.from)).toSorted()).toEqual([
    'demo-aaaa',
    'work-aaaa',
  ]);
});

it('ignores files that are not tickets, and files with different IDs, without asking Git', async () => {
  const fake = makeSync({
    folders: {
      '/store/tickets': ['demo'],
      '/store/tickets/demo': ['notes.txt', 'README.md', 'demo-aaaa-a.md', 'demo-bbbb-b.md'],
    },
  });

  const result = await resolveIdClashes(fake.functions, root);

  expect(result).toEqual({ ok: true, value: { aliases: [], moves: [] } });
  expect(fake.gitCalls).toEqual([]);
  expect(fake.renames).toEqual([]);
});

it('treats a missing tickets folder as no clashes', async () => {
  const fake = makeSync();

  const result = await resolveIdClashes(fake.functions, root);

  expect(result).toEqual({ ok: true, value: { aliases: [], moves: [] } });
  expect(fake.gitCalls).toEqual([]);
});

const permutations = [
  ['a', 'b', 'c'],
  ['a', 'c', 'b'],
  ['b', 'a', 'c'],
  ['b', 'c', 'a'],
  ['c', 'a', 'b'],
  ['c', 'b', 'a'],
];

it.each(permutations)(
  'keeps the oldest file, then the first name, whatever the listing order (%s, %s, %s)',
  async (...order) => {
    const fake = clashingStore(
      { 'demo-aaaa-b.md': '100', 'demo-aaaa-c.md': '100' },
      order.map((letter) => `demo-aaaa-${letter}.md`),
      { suffixes: ['qqqq', 'rrrr'] },
    );

    await resolveIdClashes(fake.functions, root);

    expect(movedFiles(fake).toSorted()).toEqual(['demo-aaaa-a.md', 'demo-aaaa-c.md']);
  },
);

it('stages the fact file of every reused alias', async () => {
  const fake = clashingStore(
    { 'demo-aaaa-a.md': '100', 'demo-aaaa-b.md': '200', 'demo-aaaa-c.md': '300' },
    ['demo-aaaa-a.md', 'demo-aaaa-b.md', 'demo-aaaa-c.md'],
    {
      aliases: [
        { from: 'demo-aaaa', to: 'demo-qqqq', path: 'facts/fake/first.jsonl' },
        { from: 'demo-aaaa', to: 'demo-rrrr', path: 'facts/fake/second.jsonl' },
      ],
    },
  );

  await resolveIdClashes(fake.functions, root);

  expect(
    stagedEntries(fake)
      .filter((entry) => entry.includes('facts/'))
      .toSorted(),
  ).toEqual([
    '--add --cacheinfo 100644,blob1,facts/fake/first.jsonl',
    '--add --cacheinfo 100644,blob2,facts/fake/second.jsonl',
  ]);
});

const folderPath = '/store/tickets/demo/demo-aaaa';
const folderDesign = `${folderPath}/design.md`;
const newFolderDesign = '/store/tickets/demo/demo-zzzz/design.md';

const commitFails = (args: string[]) =>
  args.includes('commit') ? gitFailure('hook refused') : undefined;

// Answers the Git calls for the folder of `demo-aaaa`, where `tracked` lists the files HEAD holds.
const folderGit = (args: string[], tracked: string[]) => {
  const command = commandOf(args);

  if (command === 'ls-tree -r -z --name-only HEAD -- tickets/demo/demo-aaaa') {
    return gitOutput(tracked.map((file) => `tickets/demo/demo-aaaa/${file}\0`).join(''));
  }

  const folderPrefix = 'ls-tree HEAD -- tickets/demo/demo-aaaa/';

  return command.startsWith(folderPrefix)
    ? gitOutput(`100644 blob abc999\t${command.slice('ls-tree HEAD -- '.length)}\n`)
    : undefined;
};

// The newer ticket `demo-aaaa-b.md` clashes, so its folder moves with it.
const folderStore = (
  extra: Parameters<typeof makeSync>[0] = {},
  files: string[] = ['design.md'],
  tracked: string[] = ['design.md'],
) =>
  clashingStore(
    { 'demo-aaaa-a.md': '100', 'demo-aaaa-b.md': '200' },
    ['demo-aaaa-a.md', 'demo-aaaa-b.md'],
    {
      ...extra,
      files: {
        [oldPath]: { text: 'ticket bytes', mtimeMs: 0 },
        ...Object.fromEntries(
          files.map((file) => [`${folderPath}/${file}`, { text: `${file} bytes`, mtimeMs: 0 }]),
        ),
        ...extra.files,
      },
      git: (args) => folderGit(args, tracked) ?? extra.git?.(args),
    },
  );

it('stages the tracked folder files at the new path and removes them at the old path', async () => {
  const fake = folderStore();

  const result = await resolveIdClashes(fake.functions, root);

  expect(result.ok).toBe(true);

  expect(stagedEntries(fake).filter((entry) => entry.includes('design.md'))).toEqual([
    '--add --cacheinfo 100644,abc999,tickets/demo/demo-zzzz/design.md',
    '--force-remove -- tickets/demo/demo-aaaa/design.md',
  ]);
});

it('moves an untracked folder file with the folder, and leaves it out of the clash commit', async () => {
  const fake = folderStore({}, ['design.md', 'notes.md'], ['design.md']);

  const result = await resolveIdClashes(fake.functions, root);

  expect(result.ok).toBe(true);
  expect(fake.disk.get('/store/tickets/demo/demo-zzzz/notes.md')?.text).toBe('notes.md bytes');
  expect(stagedEntries(fake).filter((entry) => entry.includes('notes.md'))).toEqual([]);
});

it('puts the folder back at the old path when the clash commit fails', async () => {
  let movedAtCommit: string | undefined;

  const fake: ReturnType<typeof makeSync> = folderStore({
    git: (args) => {
      if (args.includes('commit')) {
        movedAtCommit = fake.disk.get(newFolderDesign)?.text;
      }

      return commitFails(args);
    },
  });

  const result = await resolveIdClashes(fake.functions, root);

  expect(movedAtCommit).toBe('design.md bytes');
  expect(result.ok).toBe(false);
  expect(fake.disk.get(folderDesign)?.text).toBe('design.md bytes');
  expect(fake.disk.has(newFolderDesign)).toBe(false);
});

it('keeps a file saved in the old folder, and the moved folder, when the clash commit fails', async () => {
  const fake: ReturnType<typeof makeSync> = folderStore({
    git: (args) => {
      if (!args.includes('commit')) {
        return undefined;
      }

      fake.disk.set(`${folderPath}/notes.md`, { text: 'saved', mtimeMs: 0 });

      return gitFailure('hook refused');
    },
  });

  const result = await resolveIdClashes(fake.functions, root);

  expect(result.ok).toBe(false);
  expect(fake.disk.get(`${folderPath}/notes.md`)?.text).toBe('saved');
  expect(fake.disk.get(newFolderDesign)?.text).toBe('design.md bytes');
  expect(fake.disk.has(folderDesign)).toBe(false);
});

it('does not give a clashing ticket an ID that a folder already uses', async () => {
  const fake = clashingStore(
    { 'demo-aaaa-a.md': '100', 'demo-aaaa-b.md': '200' },
    ['demo-aaaa-a.md', 'demo-aaaa-b.md', 'demo-zzzz'],
    { suffixes: ['zzzz', 'qqqq'] },
  );

  const result = await resolveIdClashes(fake.functions, root);

  expect(result.ok && result.value.aliases.map((alias) => String(alias.to))).toEqual(['demo-qqqq']);
});

it('does not reuse an alias whose new ID a folder already uses', async () => {
  const fake = clashingStore(
    { 'demo-aaaa-a.md': '100', 'demo-aaaa-b.md': '200' },
    ['demo-aaaa-a.md', 'demo-aaaa-b.md', 'demo-qqqq'],
    {
      aliases: [{ from: 'demo-aaaa', to: 'demo-qqqq', path: 'facts/fake/2026-10.jsonl' }],
    },
  );

  const result = await resolveIdClashes(fake.functions, root);

  expect(result.ok && result.value.aliases.map((alias) => String(alias.to))).toEqual(['demo-zzzz']);
  expect(fake.aliasWrites()).toBe(1);
});
