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
  commitArguments: (root: string) => Promise<string[]>;
  writeBlob: (root: string, text: string) => Promise<Result<string, { message: string }>>;
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

const isTicketPath = (path: string): boolean => path.startsWith('tickets/');

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

// Puts exactly this text in the index, so the commit holds the bytes that were checked.
export const stageText = async (
  functions: SyncCommitFunctions,
  root: string,
  path: string,
  text: string,
): Promise<Result<undefined, SyncReason>> => {
  const blob = await functions.writeBlob(root, text);

  if (!blob.ok) {
    return failedReason(blob.reason.message);
  }

  const staged = await functions.runGit([
    '-C',
    root,
    'update-index',
    '--add',
    '--cacheinfo',
    `100644,${blob.value.trim()},${path}`,
  ]);

  return staged.ok ? { ok: true, value: undefined } : failedReason(staged.reason.message);
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

// A rename is committed with its alias fact, so an alias line whose new ID has no file in `HEAD`
// waits for the clash commit. A line that `HEAD` already holds is never dropped, since facts are
// append-only.
const withoutUnplacedAliases = (
  text: string,
  headNames: string[],
  committedLines: Set<string>,
): string => {
  const kept = text.split('\n').filter((line) => {
    if (committedLines.has(line)) {
      return true;
    }

    try {
      const fact: unknown = JSON.parse(line);

      if (typeof fact !== 'object' || fact === null) {
        return true;
      }

      const ticket = 'ticket' in fact ? fact.ticket : undefined;
      const isAlias = 'kind' in fact && fact.kind === 'alias' && typeof ticket === 'string';

      return !isAlias || headNames.some((name) => name.startsWith(`${ticket}-`));
    } catch {
      return true;
    }
  });

  return kept.join('\n');
};

// An ordinary commit can land while an alias waits, so the committed lines need not be a prefix
// of the file.
const filterFactText = async (
  functions: SyncCommitFunctions,
  root: string,
  path: string,
  text: string,
  headNames: string[],
): Promise<string> => {
  const head = await functions.runGit(['-C', root, 'show', `HEAD:${path}`]);
  const headText = head.ok ? head.value : '';

  const committedLines = new Set(headText.split('\n').filter((line) => line !== ''));

  return withoutUnplacedAliases(text, headNames, committedLines);
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

  return paths.map((path) => path.split('/').at(-1) ?? '');
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

// Checks the candidates together, then stages the ones that pass. Returns the ones that wait.
const stageCandidates = async (
  functions: SyncCommitFunctions,
  root: string,
  candidates: string[],
): Promise<Result<string[], SyncReason>> => {
  const texts = await Promise.all(candidates.map((path) => checkChanged(functions, root, path)));
  const pending: string[] = [];
  const headNames = await listHeadTicketNames(functions, root);

  for (const [index, checked] of texts.entries()) {
    const path = candidates[index] ?? '';

    if (checked === undefined) {
      pending.push(path);

      continue;
    }

    const text = isFactPath(path)
      ? // oxlint-disable-next-line eslint/no-await-in-loop -- Runs with the one-at-a-time staging below.
        await filterFactText(functions, root, path, checked, headNames)
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

  const changed = await listPaths(functions, root, [
    '--modified',
    '--others',
    '--exclude-standard',
  ]);

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
