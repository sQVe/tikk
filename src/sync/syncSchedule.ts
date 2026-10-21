import { join } from 'node:path';

import type { SyncFunctions } from './syncStep.ts';

export interface SyncScheduleFunctions {
  pid: number;
  runGit: SyncFunctions['runGit'];
  writeFile: (path: string, text: string) => Promise<void>;
  link: (existingPath: string, newPath: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  readFile: (path: string) => Promise<string>;
  randomSuffix: () => string;
  isProcessAlive: (pid: number) => boolean;
  sleep: (milliseconds: number) => Promise<void>;
  // Starts `tikk sync --background` detached, and returns its PID, or `undefined` when it cannot start.
  startBackground: () => number | undefined;
}

const debounceMilliseconds = 3000;
const runningPollMilliseconds = 100;
const runningPollLimit = 600;

const markerPath = (root: string): string => join(root, '.git', 'tikk.sync-scheduled');
const runningPath = (root: string): string => join(root, '.git', 'tikk.sync-running');

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

// The file appears under its name only through `link`, so a reader never sees a half-written PID.
const publishExclusive = async (
  functions: SyncScheduleFunctions,
  path: string,
): Promise<'created' | 'exists' | 'failed'> => {
  const temporaryPath = `${path}.${functions.pid}.${functions.randomSuffix()}`;

  try {
    await functions.writeFile(temporaryPath, `${functions.pid}\n`);
    await functions.link(temporaryPath, path);

    return 'created';
  } catch (error) {
    return errorCode(error) === 'EEXIST' ? 'exists' : 'failed';
  } finally {
    await functions.unlink(temporaryPath).catch(() => undefined);
  }
};

const readHolder = async (
  functions: SyncScheduleFunctions,
  path: string,
): Promise<number | undefined> => {
  try {
    const pid = Number.parseInt(await functions.readFile(path), 10);

    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

const isHeldByLiveProcess = async (
  functions: SyncScheduleFunctions,
  path: string,
): Promise<boolean> => {
  const holder = await readHolder(functions, path);

  return holder !== undefined && functions.isProcessAlive(holder);
};

const removeOwnFile = async (functions: SyncScheduleFunctions, path: string): Promise<void> => {
  if ((await readHolder(functions, path)) === functions.pid) {
    await functions.unlink(path).catch(() => undefined);
  }
};

// A file whose holder died is replaced.
const claimFile = async (functions: SyncScheduleFunctions, path: string): Promise<boolean> => {
  const first = await publishExclusive(functions, path);

  if (first !== 'exists') {
    return first === 'created';
  }

  if (await isHeldByLiveProcess(functions, path)) {
    return false;
  }

  await functions.unlink(path).catch(() => undefined);

  return (await publishExclusive(functions, path)) === 'created';
};

const hasOrigin = async (functions: SyncScheduleFunctions, root: string): Promise<boolean> => {
  const remote = await functions.runGit(['-C', root, 'remote', 'get-url', 'origin']);

  return remote.ok;
};

const handOverMarker = async (
  functions: SyncScheduleFunctions,
  path: string,
  childPid: number,
): Promise<void> => {
  const temporaryPath = `${path}.${functions.pid}.${functions.randomSuffix()}`;

  await functions.writeFile(temporaryPath, `${childPid}\n`);
  await functions.rename(temporaryPath, path);
};

const startMarkedChild = async (functions: SyncScheduleFunctions, path: string): Promise<void> => {
  const childPid = functions.startBackground();

  if (childPid === undefined) {
    await functions.unlink(path).catch(() => undefined);

    return;
  }

  await handOverMarker(functions, path, childPid);
};

// A write must never fail because of its background sync, so every error here is dropped.
export const scheduleSync = async (
  functions: SyncScheduleFunctions,
  root: string,
): Promise<void> => {
  try {
    if (!(await hasOrigin(functions, root))) {
      return;
    }

    const path = markerPath(root);

    if (!(await claimFile(functions, path))) {
      return;
    }

    await startMarkedChild(functions, path).catch(async () => {
      await functions.unlink(path).catch(() => undefined);
    });
  } catch {
    return;
  }
};

// Two children never sync at once, so the later one waits for the earlier one to finish.
const acquireRunning = async (
  functions: SyncScheduleFunctions,
  path: string,
  attemptsLeft = runningPollLimit,
): Promise<boolean> => {
  if (await claimFile(functions, path)) {
    return true;
  }

  if (attemptsLeft <= 1) {
    return false;
  }

  await functions.sleep(runningPollMilliseconds);

  return acquireRunning(functions, path, attemptsLeft - 1);
};

// Writes made while the child waits are part of its sync.
export const runBackgroundSync = async (
  functions: SyncScheduleFunctions,
  root: string,
  sync: () => Promise<unknown>,
): Promise<void> => {
  await functions.sleep(debounceMilliseconds);
  await removeOwnFile(functions, markerPath(root));

  const path = runningPath(root);

  if (!(await acquireRunning(functions, path))) {
    return;
  }

  try {
    await sync();
  } finally {
    await removeOwnFile(functions, path);
  }
};
