import type { Result } from '../result.ts';
import { resolveIdClashes } from './syncClash.ts';
import type { SyncAlias, SyncClashFunctions } from './syncClash.ts';
import { commitStore } from './syncCommit.ts';
import type { SyncReason } from './syncCommit.ts';

interface SyncLock {
  release: () => Promise<void>;
}

export interface SyncFunctions extends SyncClashFunctions {
  lockStore: () => Promise<Result<SyncLock, { kind: 'locked' | 'failed'; message: string }>>;
}

export interface SyncReport {
  committed: boolean;
  pending: string[];
  aliases: SyncAlias[];
  fetched: boolean;
  merged: boolean;
  pushed: boolean;
}

export interface SyncOptions {
  allowUnrelatedHistories: boolean;
}

interface LockedSteps {
  committed: boolean;
  pending: string[];
  aliases: SyncAlias[];
  merged: boolean;
}

// Writers wait at most five seconds for the store lock, so network steps run outside it and give up
// after this long.
const networkTimeoutMilliseconds = 10_000;
const remoteBranch = 'origin/main';

export const networkSignal = (): AbortSignal => AbortSignal.timeout(networkTimeoutMilliseconds);

const conflictReason = (root: string, files: string[]): SyncReason => ({
  kind: 'conflict',
  message: `Sync stopped: ${files.join(', ')} changed both here and on the remote. Merge ${remoteBranch} by hand in ${root}, resolve each file, and commit.`,
});

const mergeRemote = async (
  functions: SyncFunctions,
  root: string,
  options: SyncOptions,
): Promise<Result<boolean, SyncReason>> => {
  const known = await functions.runGit([
    '-C',
    root,
    'rev-parse',
    '--verify',
    '--quiet',
    remoteBranch,
  ]);

  if (!known.ok) {
    return { ok: true, value: false };
  }

  const commitOptions = await functions.commitArguments(root);
  const unrelated = options.allowUnrelatedHistories ? ['--allow-unrelated-histories'] : [];

  const merged = await functions.runGit([
    ...commitOptions,
    '-C',
    root,
    'merge',
    '--no-edit',
    '--quiet',
    ...unrelated,
    remoteBranch,
  ]);

  if (merged.ok) {
    return { ok: true, value: true };
  }

  const unmerged = await functions.runGit(['-C', root, 'diff', '--name-only', '--diff-filter=U']);
  const files = unmerged.ok ? unmerged.value.split('\n').filter((file) => file !== '') : [];

  if (files.length > 0) {
    await functions.runGit(['-C', root, 'merge', '--abort']);

    return { ok: false, reason: conflictReason(root, files) };
  }

  const inProgress = await functions.runGit([
    '-C',
    root,
    'rev-parse',
    '-q',
    '--verify',
    'MERGE_HEAD',
  ]);

  // Git refuses a merge that would overwrite a pending file before it starts, so nothing is left
  // to abort.
  if (!inProgress.ok) {
    return { ok: true, value: false };
  }

  await functions.runGit(['-C', root, 'merge', '--abort']);

  return { ok: false, reason: { kind: 'failed', message: merged.reason.message } };
};

// Sync pushes `main`, so a store on another branch is renamed first.
const ensureMainBranch = async (
  functions: SyncFunctions,
  root: string,
): Promise<Result<undefined, SyncReason>> => {
  const current = await functions.runGit(['-C', root, 'symbolic-ref', '--short', 'HEAD']);

  if (!current.ok || current.value.trim() === 'main') {
    return { ok: true, value: undefined };
  }

  const renamed = await functions.runGit(['-C', root, 'branch', '-m', 'main']);

  return renamed.ok
    ? { ok: true, value: undefined }
    : { ok: false, reason: { kind: 'failed', message: renamed.reason.message } };
};

const runLockedSteps = async (
  functions: SyncFunctions,
  root: string,
  hasRemote: boolean,
  options: SyncOptions,
): Promise<Result<LockedSteps, SyncReason>> => {
  const branch = await ensureMainBranch(functions, root);

  if (!branch.ok) {
    return branch;
  }

  const commit = await commitStore(functions, root);

  if (!commit.ok) {
    return commit;
  }

  if (!hasRemote) {
    return { ok: true, value: { ...commit.value, aliases: [], merged: false } };
  }

  const merged = await mergeRemote(functions, root, options);

  if (!merged.ok) {
    return merged;
  }

  if (!merged.value) {
    return { ok: true, value: { ...commit.value, aliases: [], merged: false } };
  }

  const clashes = await resolveIdClashes(functions, root);

  if (!clashes.ok) {
    return clashes;
  }

  const moved = new Map(clashes.value.moves.map((move) => [move.from, move.to]));
  const pending = commit.value.pending.map((path) => moved.get(path) ?? path);

  return {
    ok: true,
    value: { ...commit.value, pending, aliases: clashes.value.aliases, merged: true },
  };
};

const lockAndRun = async (
  functions: SyncFunctions,
  root: string,
  hasRemote: boolean,
  options: SyncOptions,
): Promise<Result<LockedSteps, SyncReason>> => {
  const lock = await functions.lockStore();

  if (!lock.ok) {
    return { ok: false, reason: { kind: lock.reason.kind, message: lock.reason.message } };
  }

  try {
    return await runLockedSteps(functions, root, hasRemote, options);
  } finally {
    await lock.value.release();
  }
};

const hasOrigin = async (functions: SyncFunctions, root: string): Promise<boolean> => {
  const remote = await functions.runGit(['-C', root, 'remote', 'get-url', 'origin']);

  return remote.ok;
};

// A failed fetch, such as offline, changes nothing, so the caller goes on with what it has.
export const fetchOrigin = async (functions: SyncFunctions, root: string): Promise<void> => {
  if (await hasOrigin(functions, root)) {
    await functions.runGit(['-C', root, 'fetch', '--quiet', 'origin'], networkSignal());
  }
};

// The caller holds the store lock. A conflict is aborted and left for the next sync to report, so
// the result is dropped.
export const mergeFetched = async (functions: SyncFunctions, root: string): Promise<void> => {
  if (await hasOrigin(functions, root)) {
    await runLockedSteps(functions, root, true, { allowUnrelatedHistories: false });
  }
};

export const syncStore = async (
  functions: SyncFunctions,
  root: string,
  options: SyncOptions,
): Promise<Result<SyncReport, SyncReason>> => {
  const hasRemote = await hasOrigin(functions, root);
  let fetched = false;

  if (hasRemote) {
    const fetch = await functions.runGit(
      ['-C', root, 'fetch', '--quiet', 'origin'],
      networkSignal(),
    );

    fetched = fetch.ok;
  }

  const locked = await lockAndRun(functions, root, hasRemote, options);

  if (!locked.ok) {
    return locked;
  }

  let pushed = false;

  if (hasRemote) {
    const push = await functions.runGit(
      ['-C', root, 'push', '--quiet', 'origin', 'main'],
      networkSignal(),
    );

    pushed = push.ok;
  }

  return { ok: true, value: { ...locked.value, fetched, pushed } };
};

export const pushNewStore = async (functions: SyncFunctions, root: string): Promise<boolean> => {
  const push = await functions.runGit(
    ['-C', root, 'push', '--quiet', '--set-upstream', 'origin', 'main'],
    networkSignal(),
  );

  return push.ok;
};

export const listRemoteMain = (
  functions: SyncFunctions,
  url: string,
): ReturnType<SyncFunctions['runGit']> =>
  functions.runGit(['ls-remote', '--heads', url, 'main'], networkSignal());
