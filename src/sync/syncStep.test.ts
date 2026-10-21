import { expect, it } from 'bun:test';

import { gitFailure, gitOutput, makeSync } from './syncHarness.ts';
import type { FakeSync } from './syncHarness.ts';
import { syncStore } from './syncStep.ts';

const root = '/store';
const plain = { allowUnrelatedHistories: false };
const noRemote = (args: string[]) => (args.includes('remote') ? gitFailure() : undefined);

const changedFacts = (args: string[]) =>
  args.includes('--others') ? gitOutput('facts/a/2026-10.jsonl\0') : undefined;

const callFor = (fake: FakeSync, subcommand: string) =>
  fake.gitCalls.find((call) => call.args.includes(subcommand));

it('only commits when the store has no remote', async () => {
  const fake = makeSync({ git: (args) => noRemote(args) ?? changedFacts(args) });

  const result = await syncStore(fake.functions, root, plain);

  expect(result).toEqual({
    ok: true,
    value: {
      committed: true,
      pending: [],
      aliases: [],
      fetched: false,
      merged: false,
      pushed: false,
    },
  });

  expect(fake.commands().some((command) => command.startsWith('fetch'))).toBe(false);
  expect(fake.commands().some((command) => command.startsWith('push'))).toBe(false);
});

it('fetches and pushes outside the lock with a timeout, and commits and merges under it', async () => {
  const fake = makeSync({ git: changedFacts });

  const result = await syncStore(fake.functions, root, plain);

  expect(result).toEqual({
    ok: true,
    value: { committed: true, pending: [], aliases: [], fetched: true, merged: true, pushed: true },
  });

  expect(callFor(fake, 'fetch')).toMatchObject({ signal: true, underLock: false });
  expect(callFor(fake, 'push')).toMatchObject({ signal: true, underLock: false });
  expect(callFor(fake, 'commit')).toMatchObject({ underLock: true });
  expect(callFor(fake, 'merge')).toMatchObject({ underLock: true });
  expect(callFor(fake, 'merge')?.args).toContain('--no-edit');
  expect(fake.commands().some((command) => command.startsWith('rebase'))).toBe(false);
});

it('still commits, merges, and pushes when the fetch fails', async () => {
  const fake = makeSync({
    git: (args) => (args.includes('fetch') ? gitFailure('offline') : changedFacts(args)),
  });

  const result = await syncStore(fake.functions, root, plain);

  expect(result).toMatchObject({
    ok: true,
    value: { committed: true, fetched: false, merged: true, pushed: true },
  });
});

it('reports pushed false when the push fails or the remote moved', async () => {
  const fake = makeSync({
    git: (args) => (args.includes('push') ? gitFailure('rejected') : undefined),
  });

  const result = await syncStore(fake.functions, root, plain);

  expect(result).toMatchObject({ ok: true, value: { merged: true, pushed: false } });
});

it('aborts a conflicted merge, skips the push, and names each file', async () => {
  const fake = makeSync({
    git: (args) => {
      if (args.includes('--abort')) {
        return undefined;
      }

      if (args.includes('merge')) {
        return gitFailure('conflict');
      }

      if (args.includes('--diff-filter=U')) {
        return gitOutput('tickets/demo/a.md\ntickets/demo/b.md\n');
      }

      return undefined;
    },
  });

  const result = await syncStore(fake.functions, root, plain);

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.kind).toBe('conflict');
  expect(!result.ok && result.reason.message).toContain('tickets/demo/a.md');
  expect(!result.ok && result.reason.message).toContain('tickets/demo/b.md');
  expect(callFor(fake, '--abort')).toMatchObject({ underLock: true });
  expect(callFor(fake, 'push')).toBeUndefined();
});

it('reports merged false and still pushes when git refuses the merge before it starts', async () => {
  const fake = makeSync({
    git: (args) => {
      if (args.includes('MERGE_HEAD')) {
        return gitFailure('no merge');
      }

      return args.includes('merge') ? gitFailure('would be overwritten') : undefined;
    },
  });

  const result = await syncStore(fake.functions, root, plain);

  expect(result).toMatchObject({ ok: true, value: { merged: false, pushed: true } });
  expect(callFor(fake, '--abort')).toBeUndefined();
});

it('skips the merge when the remote has no main yet', async () => {
  const fake = makeSync({ git: (args) => (args.includes('--verify') ? gitFailure() : undefined) });

  const result = await syncStore(fake.functions, root, plain);

  expect(result).toMatchObject({ ok: true, value: { merged: false, pushed: true } });
  expect(callFor(fake, 'merge')).toBeUndefined();
});

it('allows unrelated histories only when asked', async () => {
  const plainSync = makeSync();
  const firstSync = makeSync();

  await syncStore(plainSync.functions, root, plain);
  await syncStore(firstSync.functions, root, { allowUnrelatedHistories: true });

  expect(callFor(plainSync, 'merge')?.args).not.toContain('--allow-unrelated-histories');
  expect(callFor(firstSync, 'merge')?.args).toContain('--allow-unrelated-histories');
});

it('fails with locked, and commits, merges, and pushes nothing, when the lock is busy', async () => {
  const fake = makeSync({ git: changedFacts, lockFails: true });

  const result = await syncStore(fake.functions, root, plain);

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.kind).toBe('locked');

  for (const subcommand of ['add', 'commit', 'merge', 'push']) {
    expect(callFor(fake, subcommand)).toBeUndefined();
  }
});

it('commits without a Git identity as tikk, and with the configured one otherwise', async () => {
  const anonymous = makeSync({ git: changedFacts });

  const configured = makeSync({
    git: (args) =>
      args.includes('user.email') ? gitOutput('me@example.com\n') : changedFacts(args),
  });

  await syncStore(anonymous.functions, root, plain);
  await syncStore(configured.functions, root, plain);

  expect(callFor(anonymous, 'commit')?.args).toContain('user.email=tikk@localhost');
  expect(callFor(anonymous, 'merge')?.args).toContain('user.email=tikk@localhost');
  expect(callFor(configured, 'commit')?.args).not.toContain('user.email=tikk@localhost');
});

it('commits and merges unsigned, so a signing setup never prompts', async () => {
  const fake = makeSync({
    git: (args) =>
      args.includes('user.email') ? gitOutput('me@example.com\n') : changedFacts(args),
  });

  await syncStore(fake.functions, root, plain);

  expect(callFor(fake, 'commit')?.args).toContain('commit.gpgsign=false');
  expect(callFor(fake, 'merge')?.args).toContain('commit.gpgsign=false');
});
