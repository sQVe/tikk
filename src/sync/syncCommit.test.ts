import { expect, it } from 'bun:test';

import { commitStore, settlingPaths } from './syncCommit.ts';
import { gitFailure, gitOutput, makeSync } from './syncHarness.ts';

type FakeSyncOptions = NonNullable<Parameters<typeof makeSync>[0]>;

interface StrictOptions {
  failOn?: string;
  deleted?: string[];
  changed?: string[];
  hasHead?: boolean;
  headFacts?: Record<string, string>;
  headTickets?: string[];
  emptyIndexTree?: boolean;
}

const root = '/store';
const now = 100_000;

const validTicket =
  '---\nkind: instruction\ntitle: Valid\nproject: demo\nstatus: open\n---\nBody\n';

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
        'logs/abc123.log',
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
      '--add --cacheinfo 100644,blob2,logs/abc123.log',
      '--add --cacheinfo 100644,blob4,tickets/demo/settled.md',
      '--add --cacheinfo 100644,blob3,tikk.json',
      '--force-remove -- tickets/demo/gone.md',
    ].toSorted(),
  );

  expect(fake.commands()).toContain('read-tree HEAD');
});

it('stages a fresh folder file that does not parse, and keeps a fresh ticket pending', async () => {
  const folderFile = 'tickets/demo/demo-aaaa/design.md';
  const ticketFile = 'tickets/demo/demo-aaaa-a.md';

  const fake = makeSync({
    now,
    git: listing([], [folderFile, ticketFile]),
    files: {
      [`/store/${folderFile}`]: { text: 'no front matter', mtimeMs: now },
      [`/store/${ticketFile}`]: { text: 'no front matter', mtimeMs: now },
    },
  });

  const result = await commitStore(fake.functions, root);

  expect(result).toEqual({ ok: true, value: { committed: true, pending: [ticketFile] } });
  expect(stagedEntries(fake)).toEqual([`--add --cacheinfo 100644,blob1,${folderFile}`]);
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

it('does not count a folder file in HEAD as the ticket that an alias waits for', async () => {
  const factPath = 'facts/laptop/2026-10.jsonl';
  const alias = '{"version":1,"kind":"alias","ticket":"demo-qqqq","from":"demo-aaaa"}\n';

  const fake = makeSync({
    git: (args) =>
      args.includes('ls-tree')
        ? gitOutput('tickets/demo/demo-qqqq/demo-qqqq-b.md\n')
        : listing([], [factPath])(args),
    files: { [`/store/${factPath}`]: { text: alias, mtimeMs: 0 } },
  });

  await commitStore(fake.functions, root);

  expect(fake.blobs).toEqual([]);
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

const pathspecs = 'facts logs tickets tikk.json .gitattributes';

const nulList = (list: string[] | undefined): string =>
  (list ?? []).map((path) => `${path}\0`).join('');

const commandOf = (args: string[]): string => args.slice(args.indexOf('-C') + 2).join(' ');

// Answers only the exact Git calls of a commit step, so a changed argument fails the step.
const strictGit = (options: StrictOptions = {}): NonNullable<FakeSyncOptions['git']> => {
  const hasHead = options.hasHead ?? true;
  let updates = 0;

  return (args) => {
    const command = commandOf(args);
    const isCommit = command.startsWith('commit --quiet -m ');

    const failsHere = command === options.failOn;
    const failsCommit = options.failOn === 'commit' && isCommit;

    if (failsHere || failsCommit) {
      return gitFailure('injected failure');
    }

    if (command.startsWith('update-index')) {
      updates += 1;

      return gitOutput('');
    }

    const headFact = command.startsWith('show HEAD:')
      ? options.headFacts?.[command.slice('show HEAD:'.length)]
      : undefined;

    const replies: Record<string, string | undefined> = {
      'config user.email': 'me@example.com\n',
      'rev-parse --verify --quiet HEAD': hasHead ? '' : undefined,
      'read-tree HEAD': hasHead ? '' : undefined,
      'read-tree --empty': hasHead ? undefined : '',
      [`ls-files -z --deleted -- ${pathspecs}`]: nulList(options.deleted),
      [`ls-files -z --modified --others --exclude-standard -- ${pathspecs}`]: nulList(
        options.changed,
      ),
      'ls-tree -r --name-only HEAD -- tickets': hasHead
        ? (options.headTickets ?? []).join('\n')
        : undefined,
      'write-tree': options.emptyIndexTree === true || updates === 0 ? 'indextree\n' : 'newtree\n',
      'rev-parse HEAD^{tree}': 'indextree\n',
      [command.startsWith('show HEAD:') ? command : 'show']: headFact,
      [isCommit ? command : 'commit']: isCommit ? '' : undefined,
    };

    const reply = replies[command];

    return reply === undefined ? gitFailure(`unexpected git call: ${command}`) : gitOutput(reply);
  };
};

const factFile = 'facts/m/2026-10.jsonl';

const aliasLine = (ticket: string | number): string =>
  `${JSON.stringify({ version: 1, kind: 'alias', ticket, from: 'demo-aaaa' })}\n`;

const strictStore = (options: StrictOptions, files: FakeSyncOptions['files'] = {}) =>
  makeSync({ now, git: strictGit(options), files });

it('commits fact lines unchanged except an alias whose rename is not in HEAD yet', async () => {
  const committedAlias = aliasLine('demo-gone');
  const placed = aliasLine('demo-qqqq');
  const waiting = aliasLine('demo-rrrr');

  const lines = [
    committedAlias,
    placed,
    waiting,
    'not json\n',
    '42\n',
    'null\n',
    '{"version":1}\n',
    '{"kind":"log","ticket":"demo-rrrr"}\n',
    aliasLine(5),
    '\n',
  ];

  const fake = strictStore(
    {
      changed: [factFile],
      headFacts: { [factFile]: committedAlias },
      headTickets: ['tickets/demo/demo-other-x.md', 'tickets/demo/demo-qqqq-b.md'],
    },
    { [`/store/${factFile}`]: { text: lines.join(''), mtimeMs: 0 } },
  );

  const result = await commitStore(fake.functions, root);

  expect(result).toEqual({ ok: true, value: { committed: true, pending: [] } });
  expect(fake.blobs).toEqual([lines.filter((line) => line !== waiting).join('')]);
});

it('stages an empty fact file, and skips one whose only line waits for its rename', async () => {
  const empty = strictStore(
    { changed: [factFile] },
    { [`/store/${factFile}`]: { text: '', mtimeMs: 0 } },
  );

  const waiting = strictStore(
    { changed: [factFile] },
    { [`/store/${factFile}`]: { text: aliasLine('demo-rrrr'), mtimeMs: 0 } },
  );

  await commitStore(empty.functions, root);
  await commitStore(waiting.functions, root);

  expect(empty.blobs).toEqual(['']);
  expect(waiting.blobs).toEqual([]);
});

it('runs exactly the expected Git calls and commits with signing off', async () => {
  const fake = strictStore(
    { changed: ['tikk.json'], deleted: ['tickets/demo/gone.md'] },
    { '/store/tikk.json': { text: '{}', mtimeMs: 0 } },
  );

  const result = await commitStore(fake.functions, root);
  const commit = fake.gitCalls.find((call) => call.args.includes('commit'));

  expect(result).toEqual({ ok: true, value: { committed: true, pending: [] } });

  const calls = fake
    .commands()
    .filter((command) => command !== 'config user.email')
    .map((command) => (command.startsWith('commit') ? 'commit' : command));

  expect(calls).toEqual([
    'rev-parse --verify --quiet HEAD',
    'read-tree HEAD',
    `ls-files -z --deleted -- ${pathspecs}`,
    `ls-files -z --modified --others --exclude-standard -- ${pathspecs}`,
    'ls-tree -r --name-only HEAD -- tickets',
    'update-index --add --cacheinfo 100644,blob1,tikk.json',
    'update-index --force-remove -- tickets/demo/gone.md',
    'write-tree',
    'rev-parse --verify --quiet HEAD',
    'rev-parse HEAD^{tree}',
    'commit',
  ]);

  expect(commit?.args.slice(0, 2)).toEqual(['-c', 'commit.gpgsign=false']);
});

it.each([
  'read-tree HEAD',
  `ls-files -z --deleted -- ${pathspecs}`,
  `ls-files -z --modified --others --exclude-standard -- ${pathspecs}`,
  'update-index --add --cacheinfo 100644,blob1,tikk.json',
  'update-index --force-remove -- tickets/demo/gone.md',
  'write-tree',
  'rev-parse HEAD^{tree}',
  'commit',
])('fails with the Git error and commits nothing when %s fails', async (failOn) => {
  const fake = makeSync({
    now,
    git: strictGit({ changed: ['tikk.json'], deleted: ['tickets/demo/gone.md'], failOn }),
    files: { '/store/tikk.json': { text: '{}', mtimeMs: 0 } },
  });

  const result = await commitStore(fake.functions, root);

  expect(result).toEqual({ ok: false, reason: { kind: 'failed', message: 'injected failure' } });

  if (failOn !== 'commit') {
    expect(fake.commands().some((command) => command.startsWith('commit'))).toBe(false);
  }
});

it('fails with the blob error and commits nothing when the text cannot be stored', async () => {
  const fake = makeSync({
    now,
    git: strictGit({ changed: ['tikk.json'] }),
    blobFails: 'blob refused',
    files: { '/store/tikk.json': { text: '{}', mtimeMs: 0 } },
  });

  const result = await commitStore(fake.functions, root);

  expect(result).toEqual({ ok: false, reason: { kind: 'failed', message: 'blob refused' } });
  expect(fake.commands().some((command) => command.startsWith('commit'))).toBe(false);
});

it('starts from an empty index and compares with the empty tree when there is no commit', async () => {
  const fake = makeSync({
    now,
    git: strictGit({ hasHead: false, changed: ['tikk.json'] }),
    files: { '/store/tikk.json': { text: '{}', mtimeMs: 0 } },
  });

  const result = await commitStore(fake.functions, root);

  expect(result).toEqual({ ok: true, value: { committed: true, pending: [] } });
  expect(fake.commands()).toContain('read-tree --empty');
});

it('makes no commit when the index tree equals the HEAD tree', async () => {
  const fake = makeSync({ now, git: strictGit({ emptyIndexTree: true }) });

  const result = await commitStore(fake.functions, root);

  expect(result).toEqual({ ok: true, value: { committed: false, pending: [] } });
  expect(fake.commands().some((command) => command.startsWith('commit'))).toBe(false);
});

it('lists the pending paths that parse, since those settle by themselves', async () => {
  const fake = makeSync({
    files: {
      '/store/tickets/demo/fresh.md': { text: validTicket, mtimeMs: now },
      '/store/tickets/demo/broken.md': { text: 'no front matter', mtimeMs: now },
    },
  });

  const settling = await settlingPaths(fake.functions, root, [
    'tickets/demo/fresh.md',
    'tickets/demo/broken.md',
    'tickets/demo/vanished.md',
  ]);

  expect(settling).toEqual(['tickets/demo/fresh.md']);
});

it('leaves a ticket pending when its age cannot be read', async () => {
  const fake = makeSync({
    now,
    git: strictGit({ changed: ['tickets/demo/a.md'] }),
    files: { '/store/tickets/demo/a.md': { text: validTicket, mtimeMs: 0 } },
  });

  const functions = { ...fake.functions, stat: () => Promise.reject(new Error('no stat')) };
  const result = await commitStore(functions, root);

  expect(result).toEqual({ ok: true, value: { committed: false, pending: ['tickets/demo/a.md'] } });
  expect(fake.blobs).toEqual([]);
});
