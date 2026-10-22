import { expect, it } from 'bun:test';

import { gitFailure, gitOutput, makeSync } from './syncHarness.ts';
import { initRemoteStore } from './syncRemote.ts';

const root = '/store';
const url = 'git@example.com:me/tikk-store.git';
const remoteMain = 'abc123\trefs/heads/main\n';

const hasCommand = (commands: string[], prefix: string): boolean =>
  commands.some((command) => command.startsWith(prefix));

// Answers `remote get-url origin` the way Git does: it fails until `remote add` runs.
const originUntilAdded = (): ((args: string[]) => ReturnType<typeof gitOutput> | undefined) => {
  let added = false;

  return (args) => {
    if (args.includes('add') && args.includes('origin')) {
      added = true;
    }

    if (args.includes('get-url')) {
      return added ? gitOutput(`${url}\n`) : gitFailure('no origin');
    }

    return undefined;
  };
};

it('clones a remote that has main into a missing store folder, with no local commit', async () => {
  const fake = makeSync({
    folder: 'missing',
    files: { '/store.clone-tmp/tikk.json': { text: '{"version":1}', mtimeMs: 0 } },
    git: (args) => (args.includes('ls-remote') ? gitOutput(remoteMain) : undefined),
  });

  const result = await initRemoteStore(fake.functions, root, url);

  expect(result).toEqual({
    ok: true,
    value: { store: root, created: true, remote: url, pushed: true },
  });

  expect(fake.commands()).toContain(`clone --quiet --branch main ${url} /store.clone-tmp`);
  expect(fake.renames).toEqual([['/store.clone-tmp', root]]);
  expect(fake.removed).toEqual([]);
  expect(fake.initCalls()).toBe(0);
  expect(hasCommand(fake.commands(), 'commit')).toBe(false);
});

it('starts the store in an empty folder and pushes it when the remote has no main', async () => {
  const fake = makeSync({ folder: [] });

  const result = await initRemoteStore(fake.functions, root, url);
  const push = fake.gitCalls.find((call) => call.args.includes('push'));

  expect(result).toEqual({
    ok: true,
    value: { store: root, created: true, remote: url, pushed: true },
  });

  expect(fake.initCalls()).toBe(1);
  expect(fake.commands()).toContain(`remote add origin ${url}`);
  expect(push?.args).toContain('--set-upstream');
  expect(hasCommand(fake.commands(), 'clone')).toBe(false);
});

it('fails, and creates nothing, when the remote cannot be reached', async () => {
  const fake = makeSync({
    folder: 'missing',
    git: (args) => (args.includes('ls-remote') ? gitFailure('offline') : undefined),
  });

  const result = await initRemoteStore(fake.functions, root, url);

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain(url);
  expect(fake.initCalls()).toBe(0);
  expect(hasCommand(fake.commands(), 'clone')).toBe(false);
});

it('adds origin to a local store and merges unrelated histories once', async () => {
  const fake = makeSync({ folder: ['tikk.json'], git: originUntilAdded() });

  const result = await initRemoteStore(fake.functions, root, url);
  const merge = fake.gitCalls.find((call) => call.args.includes('merge'));

  expect(result).toEqual({
    ok: true,
    value: { store: root, created: true, remote: url, pushed: true },
  });

  expect(fake.commands()).toContain(`remote add origin ${url}`);
  expect(merge?.args).toContain('--allow-unrelated-histories');
  expect(hasCommand(fake.commands(), 'ls-remote')).toBe(false);
});

it('refuses a store whose origin is another URL, and changes no remote', async () => {
  const fake = makeSync({
    folder: ['tikk.json'],
    git: (args) =>
      args.includes('get-url') ? gitOutput('git@example.com:other.git\n') : undefined,
  });

  const result = await initRemoteStore(fake.functions, root, url);

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain('git@example.com:other.git');
  expect(hasCommand(fake.commands(), 'remote add')).toBe(false);
  expect(hasCommand(fake.commands(), 'merge')).toBe(false);
});

it('succeeds again on a store that already syncs with the URL', async () => {
  const fake = makeSync({
    folder: ['tikk.json'],
    git: (args) => (args.includes('get-url') ? gitOutput(`${url}\n`) : undefined),
  });

  const result = await initRemoteStore(fake.functions, root, url);

  expect(result).toEqual({
    ok: true,
    value: { store: root, created: true, remote: url, pushed: true },
  });

  expect(hasCommand(fake.commands(), 'remote add')).toBe(false);
});

it('returns the conflict when the first merge with the remote conflicts', async () => {
  const origin = originUntilAdded();

  const fake = makeSync({
    folder: ['tikk.json'],
    git: (args) => {
      const originReply = origin(args);

      if (originReply !== undefined) {
        return originReply;
      }

      if (args.includes('--diff-filter=U')) {
        return gitOutput('tickets/demo/a.md\n');
      }

      const merging = args.includes('merge') && !args.includes('--abort');

      return merging ? gitFailure('conflict') : undefined;
    },
  });

  const result = await initRemoteStore(fake.functions, root, url);

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.kind).toBe('conflict');
  expect(!result.ok && result.reason.message).toContain('tickets/demo/a.md');
});

it('clones with the network timeout signal', async () => {
  const fake = makeSync({
    folder: 'missing',
    git: (args) => (args.includes('ls-remote') ? gitOutput(remoteMain) : undefined),
  });

  await initRemoteStore(fake.functions, root, url);

  const clone = fake.gitCalls.find((call) => call.args.includes('clone'));

  expect(clone?.signal).toBe(true);
});

it('removes the clone and fails when the remote main is not a tikk store', async () => {
  const fake = makeSync({
    folder: 'missing',
    git: (args) => (args.includes('ls-remote') ? gitOutput(remoteMain) : undefined),
  });

  const result = await initRemoteStore(fake.functions, root, url);

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.kind).toBe('failed');
  expect(fake.removed).toEqual(['/store.clone-tmp']);
  expect(fake.renames).toEqual([]);
});

it('removes only the temporary folder when the store path is taken during the clone', async () => {
  const fake = makeSync({
    folder: 'missing',
    files: { '/store.clone-tmp/tikk.json': { text: '{"version":1}', mtimeMs: 0 } },
    renameFails: true,
    git: (args) => (args.includes('ls-remote') ? gitOutput(remoteMain) : undefined),
  });

  const result = await initRemoteStore(fake.functions, root, url);

  expect(result.ok).toBe(false);
  expect(fake.removed).toEqual(['/store.clone-tmp']);
});
