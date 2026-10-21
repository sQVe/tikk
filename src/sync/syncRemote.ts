import type { Result } from '../result.ts';
import type { SyncReason } from './syncCommit.ts';
import { listRemoteMain, pushNewStore, syncStore } from './syncStep.ts';
import type { SyncFunctions } from './syncStep.ts';

export interface RemoteInitFunctions extends SyncFunctions {
  initStore: () => Promise<Result<{ created: boolean }, { message: string }>>;
}

export interface RemoteStore {
  store: string;
  created: boolean;
  remote: string;
}

type Folder = 'empty' | 'filled';

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
    const cloned = await functions.runGit(['clone', '--quiet', '--branch', 'main', url, root]);

    return cloned.ok
      ? { ok: true, value: { store: root, created: true, remote: url } }
      : failed(cloned.reason.message);
  }

  const created = await initLocalStore(functions);

  if (!created.ok) {
    return created;
  }

  const origin = await addOrigin(functions, root, url);

  if (!origin.ok) {
    return origin;
  }

  await pushNewStore(functions, root);

  return { ok: true, value: { store: root, created: created.value, remote: url } };
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

  const result: RemoteStore = { store: root, created: created.value, remote: url };
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

  return synced.ok ? { ok: true, value: result } : synced;
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
