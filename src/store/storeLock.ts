import type { Result } from '../result.ts';
import { breakerFilePath, lockFilePath } from './storePaths.ts';
import type { Store } from './storePaths.ts';

export interface StoreLockFunctions {
  pid: number;
  createExclusive: (path: string, text: string) => Promise<void>;
  readFile: (path: string) => Promise<string>;
  unlink: (path: string) => Promise<void>;
  modifiedAt: (path: string) => Promise<number>;
  isProcessAlive: (pid: number) => boolean;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
}

export interface StoreLock {
  release: () => Promise<void>;
}

export interface StoreLockReason {
  kind: 'locked' | 'failed';
  message: string;
}

interface Attempt {
  functions: StoreLockFunctions;
  path: string;
  breaker: string;
  deadline: number;
  waitMilliseconds: number;
}

type Clearing = 'cleared' | 'busy';

const timeoutMilliseconds = 5000;
const minimumWaitMilliseconds = 10;
const maximumWaitMilliseconds = 50;
const breakerTimeoutMilliseconds = 5000;

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

const parsePid = (text: string): number | undefined => {
  const trimmed = text.trim();

  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    return undefined;
  }

  return Number(trimmed);
};

const failed = (message: string): Result<never, StoreLockReason> => ({
  ok: false,
  reason: { kind: 'failed', message },
});

const readHolder = async (
  functions: StoreLockFunctions,
  path: string,
): Promise<Result<number | undefined | 'gone', StoreLockReason>> => {
  try {
    return { ok: true, value: parsePid(await functions.readFile(path)) };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { ok: true, value: 'gone' };
    }

    return failed(`Cannot read ${path}.`);
  }
};

const removeLock = async (
  functions: StoreLockFunctions,
  path: string,
): Promise<Result<undefined, StoreLockReason>> => {
  try {
    await functions.unlink(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      return failed(`Cannot remove ${path}.`);
    }
  }

  return { ok: true, value: undefined };
};

const releaseLock = async (functions: StoreLockFunctions, path: string): Promise<void> => {
  const holder = await readHolder(functions, path);

  if (holder.ok && holder.value === functions.pid) {
    await functions.unlink(path).catch(() => undefined);
  }
};

// An owner that died while clearing leaves its breaker behind, so an old one is removed.
const removeAbandonedBreaker = async (
  functions: StoreLockFunctions,
  breaker: string,
): Promise<Result<undefined, StoreLockReason>> => {
  try {
    const modified = await functions.modifiedAt(breaker);

    if (functions.now() - modified <= breakerTimeoutMilliseconds) {
      return { ok: true, value: undefined };
    }
  } catch (error) {
    return errorCode(error) === 'ENOENT'
      ? { ok: true, value: undefined }
      : failed(`Cannot check ${breaker}.`);
  }

  return removeLock(functions, breaker);
};

const removeStaleLock = async (
  functions: StoreLockFunctions,
  path: string,
  stale: number | undefined,
): Promise<Result<undefined, StoreLockReason>> => {
  const current = await readHolder(functions, path);

  if (!current.ok) {
    return current;
  }

  if (current.value === 'gone' || current.value !== stale) {
    return { ok: true, value: undefined };
  }

  return removeLock(functions, path);
};

// Only the owner of the breaker may remove a stale lock, and only while the lock still holds the
// stale PID. Without it, a second process could remove the lock a first process just took.
const clearStaleLock = async (
  functions: StoreLockFunctions,
  { path, breaker }: { path: string; breaker: string },
  stale: number | undefined,
): Promise<Result<Clearing, StoreLockReason>> => {
  try {
    await functions.createExclusive(breaker, `${functions.pid}\n`);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {
      return failed(`Cannot create ${breaker}.`);
    }

    const abandoned = await removeAbandonedBreaker(functions, breaker);

    return abandoned.ok ? { ok: true, value: 'busy' } : abandoned;
  }

  const removed = await removeStaleLock(functions, path, stale);
  const released = await removeLock(functions, breaker);

  if (!removed.ok) {
    return removed;
  }

  return released.ok ? { ok: true, value: 'cleared' } : released;
};

const tryAcquire = async (attempt: Attempt): Promise<Result<StoreLock, StoreLockReason>> => {
  const { functions, path, breaker, deadline, waitMilliseconds } = attempt;

  try {
    await functions.createExclusive(path, `${functions.pid}\n`);

    return { ok: true, value: { release: () => releaseLock(functions, path) } };
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {
      return failed(`Cannot create ${path}.`);
    }
  }

  const holder = await readHolder(functions, path);

  if (!holder.ok) {
    return holder;
  }

  if (holder.value === 'gone') {
    return tryAcquire(attempt);
  }

  if (holder.value === undefined || !functions.isProcessAlive(holder.value)) {
    const cleared = await clearStaleLock(functions, { path, breaker }, holder.value);

    if (!cleared.ok) {
      return cleared;
    }

    if (cleared.value === 'cleared') {
      return tryAcquire(attempt);
    }
  }

  if (functions.now() >= deadline) {
    const message = `The store is locked by process ${holder.value}.`;

    return { ok: false, reason: { kind: 'locked', message } };
  }

  await functions.sleep(waitMilliseconds);

  const nextWait = Math.min(maximumWaitMilliseconds, waitMilliseconds + minimumWaitMilliseconds);

  return tryAcquire({ ...attempt, waitMilliseconds: nextWait });
};

export const acquireStoreLock = (
  functions: StoreLockFunctions,
  store: Store,
): Promise<Result<StoreLock, StoreLockReason>> =>
  tryAcquire({
    functions,
    path: lockFilePath(store),
    breaker: breakerFilePath(store),
    deadline: functions.now() + timeoutMilliseconds,
    waitMilliseconds: minimumWaitMilliseconds,
  });
