import { join } from 'node:path';

import type { Result } from '../result.ts';
import type { ProjectName } from '../ticket/ticket.ts';
import { parseProjectName, parseTicketFile, parseTicketFileName } from '../ticket/ticket.ts';

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
  commitArguments: (root: string) => Promise<string[]>;
  writeBlob: (root: string, text: string) => Promise<Result<string, { message: string }>>;
  stat: (path: string) => Promise<{ mtimeMs: number }>;
  lstat: (path: string) => Promise<unknown>;
  readFile: (path: string) => Promise<string>;
  readdir: (directory: string) => Promise<string[]>;
  now: () => number;
}

export interface SyncCommit {
  committed: boolean;
  pending: string[];
}

const storePathspecs = ['facts', 'logs', 'tickets', 'tikk.json', '.gitattributes'];
const settleMilliseconds = 2000;
const ticketPathSegments = 3;
const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const failedReason = (message: string): { ok: false; reason: SyncReason } => ({
  ok: false,
  reason: { kind: 'failed', message },
});

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

  return listed.ok
    ? { ok: true, value: splitPaths(listed.value) }
    : failedReason(listed.reason.message);
};

const isTicketPath = (path: string): boolean =>
  path.startsWith('tickets/') &&
  path.split('/').length === ticketPathSegments &&
  path.endsWith('.md');

const isFolderPath = (path: string): boolean => path.startsWith('tickets/') && !isTicketPath(path);

const listIgnoredFolderPaths = async (
  functions: SyncCommitFunctions,
  root: string,
): Promise<Result<string[], SyncReason>> => {
  const listed = await functions.runGit([
    '-C',
    root,
    'ls-files',
    '-z',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--',
    'tickets',
  ]);

  return listed.ok
    ? { ok: true, value: splitPaths(listed.value).filter(isFolderPath) }
    : failedReason(listed.reason.message);
};

const listChangedPaths = async (
  functions: SyncCommitFunctions,
  root: string,
): Promise<Result<string[], SyncReason>> => {
  const changed = await listPaths(functions, root, [
    '--modified',
    '--others',
    '--exclude-standard',
  ]);

  if (!changed.ok) {
    return changed;
  }

  const ignored = await listIgnoredFolderPaths(functions, root);

  return ignored.ok ? { ok: true, value: [...changed.value, ...ignored.value] } : ignored;
};

// A hand edit may still be in progress, so a ticket file is committed only when it parses and has
// not changed for two seconds. The age is read after the text, so an edit in between makes it fresh.
const isSettledText = async (
  functions: SyncCommitFunctions,
  root: string,
  path: string,
  text: string,
): Promise<boolean> => {
  try {
    const { mtimeMs } = await functions.stat(join(root, path));

    return functions.now() - mtimeMs >= settleMilliseconds && parseTicketFile(text).ok;
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

// Every sync builds its index from `HEAD`, so a failed commit leaves nothing for the next sync.
export const resetIndex = async (
  functions: SyncCommitFunctions,
  root: string,
): Promise<Result<undefined, SyncReason>> => {
  const head = await functions.runGit(['-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD']);
  const reset = await functions.runGit(['-C', root, 'read-tree', head.ok ? 'HEAD' : '--empty']);

  return reset.ok ? { ok: true, value: undefined } : failedReason(reset.reason.message);
};

const stageBlob = async (
  functions: SyncCommitFunctions,
  root: string,
  path: string,
  blobId: string,
): Promise<Result<undefined, SyncReason>> => {
  const staged = await functions.runGit([
    '-C',
    root,
    'update-index',
    '--add',
    '--cacheinfo',
    `100644,${blobId.trim()},${path}`,
  ]);

  return staged.ok ? { ok: true, value: undefined } : failedReason(staged.reason.message);
};

// Puts exactly this text in the index, so the commit holds the bytes that were checked.
export const stageText = async (
  functions: SyncCommitFunctions,
  root: string,
  path: string,
  text: string,
): Promise<Result<undefined, SyncReason>> => {
  const blob = await functions.writeBlob(root, text);

  return blob.ok ? stageBlob(functions, root, path, blob.value) : failedReason(blob.reason.message);
};

export const stageRemoval = async (
  functions: SyncCommitFunctions,
  root: string,
  path: string,
): Promise<Result<undefined, SyncReason>> => {
  const removed = await functions.runGit([
    '-C',
    root,
    'update-index',
    '--force-remove',
    '--',
    path,
  ]);

  return removed.ok ? { ok: true, value: undefined } : failedReason(removed.reason.message);
};

const isFactPath = (path: string): boolean => path.startsWith('facts/');

const isTextPath = (path: string): boolean => isTicketPath(path) || isFactPath(path);

export const readFolderNames = async (
  functions: Pick<SyncCommitFunctions, 'readdir'>,
  folder: string,
): Promise<Result<string[], SyncReason>> => {
  const listed = await functions.readdir(folder).then(
    (names) => ({ ok: true as const, value: names }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  if (listed.ok) {
    return { ok: true, value: listed.value };
  }

  const missing =
    listed.error instanceof Error && 'code' in listed.error && listed.error.code === 'ENOENT';

  return missing ? { ok: true, value: [] } : failedReason(`Cannot read ${folder}.`);
};

const projectTicketIds = async (
  functions: SyncCommitFunctions,
  root: string,
  folder: string,
  project: ProjectName,
): Promise<Result<string[], SyncReason>> => {
  const listed = await readFolderNames(functions, join(root, 'tickets', folder));

  if (!listed.ok) {
    return listed;
  }

  const ids: string[] = [];

  for (const name of listed.value) {
    const parsed = parseTicketFileName(name, project);

    if (parsed.ok) {
      ids.push(parsed.value.id);
    }
  }

  return { ok: true, value: ids };
};

const listDiskTicketIds = async (
  functions: SyncCommitFunctions,
  root: string,
): Promise<Result<string[], SyncReason>> => {
  const projects = await readFolderNames(functions, join(root, 'tickets'));

  if (!projects.ok) {
    return projects;
  }

  const ids: string[] = [];

  for (const folder of projects.value) {
    const project = parseProjectName(folder);

    if (project.ok) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Folders are read in turn.
      const listed = await projectTicketIds(functions, root, folder, project.value);

      if (!listed.ok) {
        return listed;
      }

      ids.push(...listed.value);
    }
  }

  return { ok: true, value: ids };
};

const aliasLinkOf = (line: string): { ticket: string; from: string } | undefined => {
  let fact: unknown;

  try {
    fact = JSON.parse(line);
  } catch {
    return undefined;
  }

  const fields = new Map<string, unknown>(fact instanceof Object ? Object.entries(fact) : []);
  const ticket = fields.get('ticket');
  const from = fields.get('from');

  if (fields.get('kind') !== 'alias' || typeof ticket !== 'string' || typeof from !== 'string') {
    return undefined;
  }

  return { ticket, from };
};

const isOpenClash = (link: { ticket: string; from: string }, diskIds: string[]): boolean => {
  const sharedOldId = diskIds.filter((id) => id === link.from).length > 1;
  const newIdOnDisk = diskIds.includes(link.ticket);

  return sharedOldId || newIdOnDisk;
};

const isWaitingAlias = (
  link: { ticket: string; from: string },
  headNames: string[],
  diskNames: string[],
): boolean =>
  !headNames.some((name) => name.startsWith(`${link.ticket}-`)) && isOpenClash(link, diskNames);

const withoutWaitingAliases = (
  text: string,
  headNames: string[],
  diskNames: string[],
  committedLines: Set<string>,
): string => {
  const lines = text.split('\n');

  // The last piece follows the final newline, so it is a line only once that newline is written.
  lines.pop();

  const kept: string[] = [];

  for (const line of lines) {
    const link = committedLines.has(line) ? undefined : aliasLinkOf(line);

    if (link !== undefined && isWaitingAlias(link, headNames, diskNames)) {
      break;
    }

    kept.push(`${line}\n`);
  }

  return kept.join('');
};

const filterFactText = async (
  functions: SyncCommitFunctions,
  root: string,
  path: string,
  text: string,
  headNames: string[],
  diskNames: string[],
): Promise<string> => {
  const head = await functions.runGit(['-C', root, 'show', `HEAD:${path}`]);
  const committedLines = new Set(head.ok ? head.value.split('\n') : []);

  return withoutWaitingAliases(text, headNames, diskNames, committedLines);
};

const listHeadTicketNames = async (
  functions: SyncCommitFunctions,
  root: string,
): Promise<string[]> => {
  const listed = await functions.runGit([
    '-C',
    root,
    'ls-tree',
    '-r',
    '--name-only',
    'HEAD',
    '--',
    'tickets',
  ]);

  const paths = listed.ok ? listed.value.split('\n') : [];

  return paths
    .filter((path) => isTicketPath(path))
    .map((path) => path.slice(path.lastIndexOf('/') + 1));
};

// Returns the text to commit, or `undefined` when the file waits for a later sync.
const checkChanged = async (
  functions: SyncCommitFunctions,
  root: string,
  path: string,
): Promise<string | undefined> => {
  try {
    const text = await functions.readFile(join(root, path));
    const settled = !isTicketPath(path) || (await isSettledText(functions, root, path, text));

    return settled ? text : undefined;
  } catch {
    return undefined;
  }
};

const indexDiffers = async (
  functions: SyncCommitFunctions,
  root: string,
): Promise<Result<boolean, SyncReason>> => {
  const index = await functions.runGit(['-C', root, 'write-tree']);
  const hasHead = await functions.runGit(['-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD']);

  const head = hasHead.ok
    ? await functions.runGit(['-C', root, 'rev-parse', 'HEAD^{tree}'])
    : { ok: true as const, value: emptyTree };

  if (!index.ok) {
    return failedReason(index.reason.message);
  }

  if (!head.ok) {
    return failedReason(head.reason.message);
  }

  return { ok: true, value: index.value.trim() !== head.value.trim() };
};

const commitIndex = async (
  functions: SyncCommitFunctions,
  root: string,
): Promise<Result<undefined, SyncReason>> => {
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

  return committed.ok ? { ok: true, value: undefined } : failedReason(committed.reason.message);
};

const isPresent = async (
  functions: SyncCommitFunctions,
  root: string,
  path: string,
): Promise<boolean> => {
  try {
    // lstat, not stat, so a symlink whose target is missing still counts as present.
    await functions.lstat(join(root, path));

    return true;
  } catch {
    return false;
  }
};

// The index takes the mode and bytes on disk, or the link target of a symlink. Autocrlf is off so
// line endings stay as written. A file that is gone waits for a later sync, as a text file does.
const stageDesignFile = async (
  functions: SyncCommitFunctions,
  root: string,
  path: string,
): Promise<Result<boolean, SyncReason>> => {
  if (!(await isPresent(functions, root, path))) {
    return { ok: true, value: false };
  }

  const staged = await functions.runGit([
    '-c',
    'core.autocrlf=false',
    '-C',
    root,
    'update-index',
    '--add',
    '--',
    path,
  ]);

  return staged.ok ? { ok: true, value: true } : failedReason(staged.reason.message);
};

const stageCandidates = async (
  functions: SyncCommitFunctions,
  root: string,
  candidates: string[],
): Promise<Result<string[], SyncReason>> => {
  const texts = await Promise.all(
    candidates.map((path) =>
      isTextPath(path) ? checkChanged(functions, root, path) : Promise.resolve(undefined),
    ),
  );

  const pending: string[] = [];
  const headNames = await listHeadTicketNames(functions, root);
  const diskNames = await listDiskTicketIds(functions, root);

  if (!diskNames.ok) {
    return diskNames;
  }

  for (const [index, path] of candidates.entries()) {
    if (!isTextPath(path)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Runs with the one-at-a-time staging below.
      const design = await stageDesignFile(functions, root, path);

      if (!design.ok) {
        return design;
      }

      if (!design.value) {
        pending.push(path);
      }

      continue;
    }

    const checked = texts[index];

    if (checked === undefined) {
      pending.push(path);

      continue;
    }

    const text = isFactPath(path)
      ? // oxlint-disable-next-line eslint/no-await-in-loop -- Runs with the one-at-a-time staging below.
        await filterFactText(functions, root, path, checked, headNames, diskNames.value)
      : checked;

    if (text === '' && checked !== '') {
      continue;
    }

    // Each call rewrites the index file, so they run one at a time.
    // oxlint-disable-next-line eslint/no-await-in-loop -- See above.
    const staged = await stageText(functions, root, path, text);

    if (!staged.ok) {
      return staged;
    }
  }

  return { ok: true, value: pending };
};

export const commitStore = async (
  functions: SyncCommitFunctions,
  root: string,
): Promise<Result<SyncCommit, SyncReason>> => {
  const reset = await resetIndex(functions, root);

  if (!reset.ok) {
    return reset;
  }

  const deleted = await listPaths(functions, root, ['--deleted']);

  if (!deleted.ok) {
    return deleted;
  }

  const changed = await listChangedPaths(functions, root);

  if (!changed.ok) {
    return changed;
  }

  const deletedPaths = new Set(deleted.value);
  const candidates = changed.value.filter((path) => !deletedPaths.has(path));
  const pending = await stageCandidates(functions, root, candidates);

  if (!pending.ok) {
    return pending;
  }

  for (const path of deletedPaths) {
    // Removals run one at a time, since each call rewrites the index file.
    // oxlint-disable-next-line eslint/no-await-in-loop -- See above.
    const removed = await stageRemoval(functions, root, path);

    if (!removed.ok) {
      return removed;
    }
  }

  const differs = await indexDiffers(functions, root);

  if (!differs.ok) {
    return differs;
  }

  if (!differs.value) {
    return { ok: true, value: { committed: false, pending: pending.value } };
  }

  const committed = await commitIndex(functions, root);

  return committed.ok
    ? { ok: true, value: { committed: true, pending: pending.value } }
    : committed;
};
