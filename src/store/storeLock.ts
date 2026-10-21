import type { Result } from '../result.ts';
import { breakerFilePath, lockFilePath } from './storePaths.ts';
import type { Store } from './storePaths.ts';

export interface StoreLockFunctions {
  pid: number;
  writeFile: (path: string, text: string) => Promise<void>;
  link: (existingPath: string, newPath: string) => Promise<void>;
  randomSuffix: () => string;
  readFile: (path: string) => Promise<string>;
  unlink: (path: string) => Promise<void>;
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

// The file appears under its name only through `link`, which fails with EEXIST when the name is
// taken. So a reader never sees the lock or the breaker without the PID of its holder.
const publishExclusive = async (functions: StoreLockFunctions, path: string): Promise<void> => {
  const temporaryPath = `${path}.${functions.pid}.${functions.randomSuffix()}`;

  try {
    await functions.writeFile(temporaryPath, `${functions.pid}\n`);
    await functions.link(temporaryPath, path);
  } finally {
    await functions.unlink(temporaryPath).catch(() => undefined);
  }
};

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

const isStale = (functions: StoreLockFunctions, holder: number | undefined): boolean =>
  holder === undefined || !functions.isProcessAlive(holder);

// An owner that died while clearing leaves its breaker behind. A breaker of a live owner stays,
// however old it is, because that owner may still remove the lock it read as stale.
const removeDeadBreaker = async (
  functions: StoreLockFunctions,
  breaker: string,
): Promise<Result<undefined, StoreLockReason>> => {
  const owner = await readHolder(functions, breaker);

  if (!owner.ok) {
    return owner;
  }

  if (owner.value === 'gone' || !isStale(functions, owner.value)) {
    return { ok: true, value: undefined };
  }

  return removeStaleLock(functions, breaker, owner.value);
};

// Only the owner of the breaker may remove a stale lock, and only while the lock still holds the
// stale PID. Without it, a second process could remove the lock a first process just took.
const clearStaleLock = async (
  functions: StoreLockFunctions,
  { path, breaker }: { path: string; breaker: string },
  stale: number | undefined,
): Promise<Result<Clearing, StoreLockReason>> => {
  try {
    await publishExclusive(functions, breaker);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {
      return failed(`Cannot create ${breaker}.`);
    }

    const abandoned = await removeDeadBreaker(functions, breaker);

    return abandoned.ok ? { ok: true, value: 'busy' } : abandoned;
  }

  const removed = await removeStaleLock(functions, path, stale);
  const released = await removeLock(functions, breaker);

  if (!removed.ok) {
    return removed;
  }

  return released.ok ? { ok: true, value: 'cleared' } : released;
};

const lockedResult = (message: string): Result<never, StoreLockReason> => ({
  ok: false,
  reason: { kind: 'locked', message },
});

const tryAcquire = async (attempt: Attempt): Promise<Result<StoreLock, StoreLockReason>> => {
  const { functions, path, breaker, deadline, waitMilliseconds } = attempt;

  try {
    await publishExclusive(functions, path);

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

  const holderPid = holder.value === 'gone' ? undefined : holder.value;
  let vacated = holder.value === 'gone';

  if (!vacated && isStale(functions, holderPid)) {
    const cleared = await clearStaleLock(functions, { path, breaker }, holderPid);

    if (!cleared.ok) {
      return cleared;
    }

    vacated = cleared.value === 'cleared';
  }

  if (functions.now() >= deadline) {
    const message = vacated
      ? 'The store lock kept changing until the timeout.'
      : `The store is locked by process ${holder.value}.`;

    return lockedResult(message);
  }

  // The lock may be free now, so try again at once.
  if (vacated) {
    return tryAcquire(attempt);
  }

  await functions.sleep(waitMilliseconds);

  // The sleep may end after the deadline, and a lock published then would outlive the timeout.
  if (functions.now() >= deadline) {
    return lockedResult(`The store is locked by process ${holder.value}.`);
  }

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
