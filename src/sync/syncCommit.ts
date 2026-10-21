import { join } from 'node:path';

import type { Result } from '../result.ts';
import { commitArguments } from '../store/store.ts';
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
const isSettledTicket = async (
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

const commitStaged = async (
  functions: SyncCommitFunctions,
  root: string,
  paths: string[],
): Promise<Result<undefined, SyncReason>> => {
  const added = await functions.runGit(['-C', root, 'add', '-A', '--', ...paths]);

  if (!added.ok) {
    return { ok: false, reason: { kind: 'failed', message: added.reason.message } };
  }

  const commitOptions = await commitArguments(functions.runGit, root);

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

  const pending = candidates.filter((_path, index) => settled[index] === false);
  const pendingPaths = new Set(pending);

  const staged = new Set([
    ...deletedPaths,
    ...candidates.filter((_path, index) => settled[index] === true),
    ...indexed.value.filter((path) => !pendingPaths.has(path)),
  ]);

  if (staged.size === 0) {
    return { ok: true, value: { committed: false, pending } };
  }

  const committed = await commitStaged(functions, root, [...staged]);

  return committed.ok ? { ok: true, value: { committed: true, pending } } : committed;
};
