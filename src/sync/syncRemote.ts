import { z } from 'zod';

import type { Result } from '../result.ts';
import type { SyncReason } from './syncCommit.ts';
import { listRemoteMain, networkSignal, pushNewStore, syncStore } from './syncStep.ts';
import type { SyncFunctions } from './syncStep.ts';

export interface RemoteInitFunctions extends SyncFunctions {
  initStore: () => Promise<Result<{ created: boolean }, { message: string }>>;
  // Creates a new empty folder named with the prefix and a random suffix, and returns its path.
  makeTempFolder: (prefix: string) => Promise<string>;
  // Removes a folder this process created, with everything in it.
  removeTree: (path: string) => Promise<void>;
}

export interface RemoteStore {
  store: string;
  created: boolean;
  remote: string;
  pushed: boolean;
}

type Folder = 'empty' | 'filled';

const storeConfigSchema = z.object({ version: z.literal(1) });

const failed = (message: string): { ok: false; reason: SyncReason } => ({
  ok: false,
  reason: { kind: 'failed', message },
});

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const inspectFolder = async (
  functions: RemoteInitFunctions,
  root: string,
): Promise<Result<Folder, SyncReason>> => {
  try {
    const entries = await functions.readdir(root);

    return { ok: true, value: entries.length === 0 ? 'empty' : 'filled' };
  } catch (error) {
    return isMissingFile(error) ? { ok: true, value: 'empty' } : failed(`Cannot read ${root}.`);
  }
};

const initLocalStore = async (
  functions: RemoteInitFunctions,
): Promise<Result<boolean, SyncReason>> => {
  const initialized = await functions.initStore();

  return initialized.ok
    ? { ok: true, value: initialized.value.created }
    : failed(initialized.reason.message);
};

const addOrigin = async (
  functions: RemoteInitFunctions,
  root: string,
  url: string,
): Promise<Result<undefined, SyncReason>> => {
  const added = await functions.runGit(['-C', root, 'remote', 'add', 'origin', url]);

  return added.ok ? { ok: true, value: undefined } : failed(added.reason.message);
};

const isStoreConfig = (text: string): boolean => {
  try {
    return storeConfigSchema.safeParse(JSON.parse(text)).success;
  } catch {
    return false;
  }
};

const occupiedCodes = new Set(['ENOTEMPTY', 'EEXIST']);

const isOccupied = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && occupiedCodes.has(String(error.code));

const cloneInto = async (
  functions: RemoteInitFunctions,
  root: string,
  url: string,
  temporary: string,
): Promise<Result<undefined, SyncReason>> => {
  const cloned = await functions.runGit(
    ['clone', '--quiet', '--branch', 'main', url, temporary],
    networkSignal(),
  );

  if (!cloned.ok) {
    return failed(cloned.reason.message);
  }

  const text = await functions.readFile(`${temporary}/tikk.json`).catch(() => undefined);

  if (text === undefined || !isStoreConfig(text)) {
    return failed('The remote is not a tikk store: its main has no valid tikk.json.');
  }

  try {
    await functions.rename(temporary, root);
  } catch (error) {
    return failed(
      isOccupied(error)
        ? `${root} is not empty, so the clone was not moved there.`
        : `Cannot move the clone to ${root}.`,
    );
  }

  return { ok: true, value: undefined };
};

// The clone lands in a folder this process owns. It moves onto the store path only after the check,
// and a store path that is not empty is never overwritten.
const cloneStore = async (
  functions: RemoteInitFunctions,
  root: string,
  url: string,
): Promise<Result<undefined, SyncReason>> => {
  const temporary = await functions.makeTempFolder(`${root}.clone-`).catch(() => undefined);

  if (temporary === undefined) {
    return failed(`Cannot create a folder next to ${root}.`);
  }

  const result = await cloneInto(functions, root, url, temporary);

  if (!result.ok) {
    await functions.removeTree(temporary).catch(() => undefined);
  }

  return result;
};

// A remote that already has `main` holds another machine's store, so the empty folder becomes a
// clone of it. Otherwise this machine starts the history and pushes it.
const startFromEmptyFolder = async (
  functions: RemoteInitFunctions,
  root: string,
  url: string,
): Promise<Result<RemoteStore, SyncReason>> => {
  const heads = await listRemoteMain(functions, url);

  if (!heads.ok) {
    return failed(`Cannot reach the remote ${url}: ${heads.reason.message}`);
  }

  if (heads.value.trim() !== '') {
    const cloned = await cloneStore(functions, root, url);

    return cloned.ok
      ? { ok: true, value: { store: root, created: true, remote: url, pushed: true } }
      : cloned;
  }

  const created = await initLocalStore(functions);

  if (!created.ok) {
    return created;
  }

  const origin = await addOrigin(functions, root, url);

  if (!origin.ok) {
    return origin;
  }

  const pushed = await pushNewStore(functions, root);

  return { ok: true, value: { store: root, created: created.value, remote: url, pushed } };
};

const connectExistingStore = async (
  functions: RemoteInitFunctions,
  root: string,
  url: string,
): Promise<Result<RemoteStore, SyncReason>> => {
  const created = await initLocalStore(functions);

  if (!created.ok) {
    return created;
  }

  const current = await functions.runGit(['-C', root, 'remote', 'get-url', 'origin']);

  if (current.ok) {
    const currentUrl = current.value.trim();

    if (currentUrl !== url) {
      return failed(`The store at ${root} already syncs with ${currentUrl}, not ${url}.`);
    }
  } else {
    const origin = await addOrigin(functions, root, url);

    if (!origin.ok) {
      return origin;
    }
  }

  // A matching origin may come from an earlier run that was offline and never joined the histories,
  // so the first sync runs again.
  const synced = await syncStore(functions, root, { allowUnrelatedHistories: true });

  if (!synced.ok) {
    return synced;
  }

  const { pushed } = synced.value;

  return { ok: true, value: { store: root, created: created.value, remote: url, pushed } };
};

export const initRemoteStore = async (
  functions: RemoteInitFunctions,
  root: string,
  url: string,
): Promise<Result<RemoteStore, SyncReason>> => {
  const folder = await inspectFolder(functions, root);

  if (!folder.ok) {
    return folder;
  }

  if (folder.value === 'empty') {
    return startFromEmptyFolder(functions, root, url);
  }

  return connectExistingStore(functions, root, url);
};
