import type { Result } from '../result.ts';
import { commitArguments } from '../store/store.ts';
import { commitStore } from './syncCommit.ts';
import type { SyncCommitFunctions, SyncReason } from './syncCommit.ts';

interface SyncLock {
  release: () => Promise<void>;
}

export interface SyncFunctions extends SyncCommitFunctions {
  lockStore: () => Promise<Result<SyncLock, { kind: 'locked' | 'failed'; message: string }>>;
}

export interface SyncReport {
  committed: boolean;
  pending: string[];
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
  merged: boolean;
}

// Writers wait at most five seconds for the store lock, so network steps run outside it and give up
// after this long.
const networkTimeoutMilliseconds = 10_000;
const remoteBranch = 'origin/main';

const networkSignal = (): AbortSignal => AbortSignal.timeout(networkTimeoutMilliseconds);

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

  const commitOptions = await commitArguments(functions.runGit, root);
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

  // Git refuses a merge that would overwrite a pending file before it starts, so nothing is left
  // to abort.
  if (files.length === 0) {
    return { ok: true, value: false };
  }

  await functions.runGit(['-C', root, 'merge', '--abort']);

  return { ok: false, reason: conflictReason(root, files) };
};

const runLockedSteps = async (
  functions: SyncFunctions,
  root: string,
  hasRemote: boolean,
  options: SyncOptions,
): Promise<Result<LockedSteps, SyncReason>> => {
  const commit = await commitStore(functions, root);

  if (!commit.ok) {
    return commit;
  }

  if (!hasRemote) {
    return { ok: true, value: { ...commit.value, merged: false } };
  }

  const merged = await mergeRemote(functions, root, options);

  if (!merged.ok) {
    return merged;
  }

  return { ok: true, value: { ...commit.value, merged: merged.value } };
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

// The caller holds the store lock. A conflict is aborted and left for the next sync to report.
export const mergeFetched = async (
  functions: SyncFunctions,
  root: string,
): Promise<Result<undefined, SyncReason>> => {
  if (!(await hasOrigin(functions, root))) {
    return { ok: true, value: undefined };
  }

  const steps = await runLockedSteps(functions, root, true, { allowUnrelatedHistories: false });

  return steps.ok ? { ok: true, value: undefined } : steps;
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
