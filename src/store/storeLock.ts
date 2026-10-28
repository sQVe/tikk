import { basename, dirname } from 'node:path';

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
  readdir: (directory: string) => Promise<string[]>;
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
  // Attempts at once after one that cleared a stale lock, before the deadline decides.
  vacatedRetries: number;
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
// taken. So a reader never sees the lock or a breaker generation without the PID of its holder.
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

const generationPath = (breaker: string, generation: number): string => `${breaker}.${generation}`;

const releasePath = (generation: string): string => `${generation}.released`;

// Temporary files share the prefix, so only an exact number, alone or with the release suffix,
// names a generation. A marker counts even without its generation file, so no number is reused.
const generationNumber = (name: string, prefix: string): number | undefined => {
  if (!name.startsWith(prefix)) {
    return undefined;
  }

  const match = /^(0|[1-9][0-9]*)(\.released)?$/.exec(name.slice(prefix.length));

  return match === null ? undefined : Number(match[1]);
};

const latestGeneration = async (
  functions: StoreLockFunctions,
  breaker: string,
): Promise<Result<{ generation: number; released: boolean } | undefined, StoreLockReason>> => {
  const directory = dirname(breaker);
  let names: string[];

  try {
    names = await functions.readdir(directory);
  } catch {
    return failed(`Cannot list ${directory}.`);
  }

  const prefix = `${basename(breaker)}.`;

  const generations = names
    .map((name) => generationNumber(name, prefix))
    .filter((generation) => generation !== undefined);

  if (generations.length === 0) {
    return { ok: true, value: undefined };
  }

  const generation = Math.max(...generations);
  const released = names.includes(basename(releasePath(generationPath(breaker, generation))));

  return { ok: true, value: { generation, released } };
};

// No process removes a generation, so only one process can link the one after it. A generation of a
// live owner stays held however old it is, because that owner may still remove the lock it read as
// stale.
const nextGeneration = async (
  functions: StoreLockFunctions,
  breaker: string,
): Promise<Result<number | 'busy', StoreLockReason>> => {
  const latest = await latestGeneration(functions, breaker);

  if (!latest.ok) {
    return latest;
  }

  if (latest.value === undefined) {
    return { ok: true, value: 0 };
  }

  const { generation, released } = latest.value;

  if (released) {
    return { ok: true, value: generation + 1 };
  }

  const owner = await readHolder(functions, generationPath(breaker, generation));

  if (!owner.ok) {
    return owner;
  }

  if (owner.value === 'gone' || !isStale(functions, owner.value)) {
    return { ok: true, value: 'busy' };
  }

  return { ok: true, value: generation + 1 };
};

const releaseGeneration = async (
  functions: StoreLockFunctions,
  generation: string,
): Promise<Result<undefined, StoreLockReason>> => {
  try {
    await publishExclusive(functions, releasePath(generation));
  } catch {
    return failed(`Cannot release ${generation}.`);
  }

  return { ok: true, value: undefined };
};

// Only the owner of a breaker generation may remove a stale lock, and only while the lock still
// holds the stale PID. Without it, a second process could remove the lock a first process just took.
const clearStaleLock = async (
  functions: StoreLockFunctions,
  { path, breaker }: { path: string; breaker: string },
  stale: number | undefined,
): Promise<Result<Clearing, StoreLockReason>> => {
  const next = await nextGeneration(functions, breaker);

  if (!next.ok) {
    return next;
  }

  if (next.value === 'busy') {
    return { ok: true, value: 'busy' };
  }

  const generation = generationPath(breaker, next.value);

  try {
    await publishExclusive(functions, generation);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {
      return failed(`Cannot create ${generation}.`);
    }

    return { ok: true, value: 'busy' };
  }

  const removed = await removeStaleLock(functions, path, stale);
  const released = await releaseGeneration(functions, generation);

  if (!removed.ok) {
    return removed;
  }

  return released.ok ? { ok: true, value: 'cleared' } : released;
};

const lockedResult = (message: string): Result<never, StoreLockReason> => ({
  ok: false,
  reason: { kind: 'locked', message },
});

// True when the lock is gone or this process cleared it as stale.
const vacateStaleLock = async (
  functions: StoreLockFunctions,
  paths: { path: string; breaker: string },
  holder: number | undefined | 'gone',
): Promise<Result<boolean, StoreLockReason>> => {
  if (holder === 'gone') {
    return { ok: true, value: true };
  }

  if (!isStale(functions, holder)) {
    return { ok: true, value: false };
  }

  const cleared = await clearStaleLock(functions, paths, holder);

  return cleared.ok ? { ok: true, value: cleared.value === 'cleared' } : cleared;
};

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

  const vacancy = await vacateStaleLock(functions, { path, breaker }, holder.value);

  if (!vacancy.ok) {
    return vacancy;
  }

  const vacated = vacancy.value;

  if (vacated && attempt.vacatedRetries > 0) {
    return tryAcquire({ ...attempt, vacatedRetries: attempt.vacatedRetries - 1 });
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
    vacatedRetries: 0,
  });

// Makes one attempt and never sleeps. A stale lock is still cleared, and then taken at once.
export const tryStoreLock = (
  functions: StoreLockFunctions,
  store: Store,
): Promise<Result<StoreLock, StoreLockReason>> =>
  tryAcquire({
    functions,
    path: lockFilePath(store),
    breaker: breakerFilePath(store),
    deadline: functions.now(),
    waitMilliseconds: minimumWaitMilliseconds,
    vacatedRetries: 1,
  });
