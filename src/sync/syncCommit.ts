import { join } from 'node:path';

import type { Result } from '../result.ts';
import { parseTicketFile } from '../ticket/ticket.ts';

export interface SyncReason {
  kind: 'conflict' | 'locked' | 'failed';
  message: string;
}

type SyncGit = (
  args: string[],
  signal?: AbortSignal,
) => Promise<Result<string, { message: string }>>;

export interface SyncCommitFunctions {
  runGit: SyncGit;
  // The arguments that go before `commit` or `merge`.
  commitArguments: (root: string) => Promise<string[]>;
  stat: (path: string) => Promise<{ mtimeMs: number }>;
  readFile: (path: string) => Promise<string>;
  now: () => number;
}

export interface SyncCommit {
  committed: boolean;
  pending: string[];
}

const storePathspecs = ['facts', 'tickets', 'tikk.json', '.gitattributes'];
const settleMilliseconds = 2000;

const splitPaths = (output: string): string[] => output.split('\0').filter((path) => path !== '');

const listPaths = async (
  functions: SyncCommitFunctions,
  root: string,
  filters: string[],
): Promise<Result<string[], SyncReason>> => {
  const listed = await functions.runGit([
    '-C',
    root,
    'ls-files',
    '-z',
    ...filters,
    '--',
    ...storePathspecs,
  ]);

  if (!listed.ok) {
    return { ok: false, reason: { kind: 'failed', message: listed.reason.message } };
  }

  return { ok: true, value: splitPaths(listed.value) };
};

// A failed commit leaves its changes in the index, where `ls-files --modified` does not list them.
const listStagedPaths = async (
  functions: SyncCommitFunctions,
  root: string,
): Promise<Result<string[], SyncReason>> => {
  const listed = await functions.runGit([
    '-C',
    root,
    'diff',
    '--cached',
    '--name-only',
    '-z',
    '--',
    ...storePathspecs,
  ]);

  if (!listed.ok) {
    return { ok: false, reason: { kind: 'failed', message: listed.reason.message } };
  }

  return { ok: true, value: splitPaths(listed.value) };
};

// A hand edit may still be in progress, so a ticket file is committed only when it parses and has
// not changed for two seconds.
export const isSettledTicket = async (
  functions: SyncCommitFunctions,
  root: string,
  path: string,
): Promise<boolean> => {
  try {
    const { mtimeMs } = await functions.stat(join(root, path));

    if (functions.now() - mtimeMs < settleMilliseconds) {
      return false;
    }

    const text = await functions.readFile(join(root, path));

    return parseTicketFile(text).ok;
  } catch {
    return false;
  }
};

// A fresh file that parses will settle by itself, so a later sync can commit it.
export const settlingPaths = async (
  functions: SyncCommitFunctions,
  root: string,
  pending: string[],
): Promise<string[]> => {
  const parsed = await Promise.all(
    pending.map(async (path) => {
      try {
        return parseTicketFile(await functions.readFile(join(root, path))).ok;
      } catch {
        return false;
      }
    }),
  );

  return pending.filter((_path, index) => parsed[index] === true);
};

const isTicketPath = (path: string): boolean => path.startsWith('tickets/');

// A staged deletion has no file left to check, and is committed.
const isStagedSettled = async (
  functions: SyncCommitFunctions,
  root: string,
  path: string,
): Promise<boolean> => {
  if (!isTicketPath(path)) {
    return true;
  }

  const exists = await functions.stat(join(root, path)).then(
    () => true,
    () => false,
  );

  return exists ? isSettledTicket(functions, root, path) : true;
};

const indexedParses = async (
  functions: SyncCommitFunctions,
  root: string,
  path: string,
): Promise<boolean> => {
  const shown = await functions.runGit(['-C', root, 'show', `:${path}`]);

  return shown.ok && parseTicketFile(shown.value).ok;
};

// A path edited after it was staged is judged by its staged snapshot, so a valid snapshot (such as
// a rename with its alias fact) is committed and only the worktree edit waits.
const isIndexedSettled = async (
  functions: SyncCommitFunctions,
  root: string,
  path: string,
  modified: Set<string>,
): Promise<boolean> => {
  if (isTicketPath(path) && modified.has(path)) {
    return indexedParses(functions, root, path);
  }

  return isStagedSettled(functions, root, path);
};

const unstage = async (
  functions: SyncCommitFunctions,
  root: string,
  paths: string[],
): Promise<Result<undefined, SyncReason>> => {
  if (paths.length === 0) {
    return { ok: true, value: undefined };
  }

  const reset = await functions.runGit(['-C', root, 'reset', '--quiet', '--', ...paths]);

  return reset.ok
    ? { ok: true, value: undefined }
    : { ok: false, reason: { kind: 'failed', message: reset.reason.message } };
};

const commitStaged = async (
  functions: SyncCommitFunctions,
  root: string,
  paths: string[],
): Promise<Result<undefined, SyncReason>> => {
  // Paths already in the index are left out, since `git add` fails on a staged deletion.
  if (paths.length > 0) {
    const added = await functions.runGit(['-C', root, 'add', '-A', '--', ...paths]);

    if (!added.ok) {
      return { ok: false, reason: { kind: 'failed', message: added.reason.message } };
    }
  }

  const commitOptions = await functions.commitArguments(root);

  const committed = await functions.runGit([
    ...commitOptions,
    '-C',
    root,
    'commit',
    '--quiet',
    '-m',
    'Sync the tikk store',
  ]);

  if (!committed.ok) {
    return { ok: false, reason: { kind: 'failed', message: committed.reason.message } };
  }

  return { ok: true, value: undefined };
};

export const commitStore = async (
  functions: SyncCommitFunctions,
  root: string,
): Promise<Result<SyncCommit, SyncReason>> => {
  const deleted = await listPaths(functions, root, ['--deleted']);

  if (!deleted.ok) {
    return deleted;
  }

  const changed = await listPaths(functions, root, [
    '--modified',
    '--others',
    '--exclude-standard',
  ]);

  if (!changed.ok) {
    return changed;
  }

  const indexed = await listStagedPaths(functions, root);

  if (!indexed.ok) {
    return indexed;
  }

  const deletedPaths = new Set(deleted.value);
  const candidates = changed.value.filter((path) => !deletedPaths.has(path));

  const settled = await Promise.all(
    candidates.map((path) =>
      isTicketPath(path) ? isSettledTicket(functions, root, path) : Promise.resolve(true),
    ),
  );

  const indexedSettled = await Promise.all(
    indexed.value.map((path) => isIndexedSettled(functions, root, path, new Set(changed.value))),
  );

  const unsettledIndexed = indexed.value.filter((_path, index) => indexedSettled[index] === false);
  const unstaged = await unstage(functions, root, unsettledIndexed);

  if (!unstaged.ok) {
    return unstaged;
  }

  const unsettledStaged = new Set(unsettledIndexed);
  const pending = candidates.filter((_path, index) => settled[index] === false);

  for (const path of unsettledIndexed) {
    if (!pending.includes(path)) {
      pending.push(path);
    }
  }

  const staged = new Set([
    ...deletedPaths,
    ...candidates.filter((_path, index) => settled[index] === true),
  ]);

  const hasIndexed = indexed.value.some((path) => !unsettledStaged.has(path));

  if (staged.size === 0 && !hasIndexed) {
    return { ok: true, value: { committed: false, pending } };
  }

  const committed = await commitStaged(functions, root, [...staged]);

  return committed.ok ? { ok: true, value: { committed: true, pending } } : committed;
};
