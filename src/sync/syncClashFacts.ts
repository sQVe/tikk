import { join, relative } from 'node:path';

import { parseFactLine } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import type { TicketId } from '../ticket/ticket.ts';
import type { SyncCommitFunctions, SyncReason } from './syncCommit.ts';

export interface MovedFactReference {
  path: string;
  line: number;
}

type GitFunctions = Pick<SyncCommitFunctions, 'runGit'>;

interface MergeSides {
  renamed: string;
  surviving: string;
}

interface ClashSides extends MergeSides {
  // The renamed side's parent of the newest merge. Lines it adds after the merge that brought the
  // file in are on this side, so a later retry still moves them.
  tip: string;
}

interface SidePaths {
  renamed: string[];
  surviving: string[];
}

const factsFolder = 'facts';

const failed = (message: string): { ok: false; reason: SyncReason } => ({
  ok: false,
  reason: { kind: 'failed', message },
});

const listPaths = async (
  functions: GitFunctions,
  root: string,
  revision: string,
  pathspec: string,
): Promise<Result<string[], SyncReason>> => {
  const listed = await functions.runGit([
    '-C',
    root,
    'ls-tree',
    '-r',
    '-z',
    '--name-only',
    revision,
    '--',
    pathspec,
  ]);

  if (!listed.ok) {
    return failed(listed.reason.message);
  }

  return { ok: true, value: listed.value.split('\0').filter((path) => path !== '') };
};

const firstParentMerges = async (
  functions: GitFunctions,
  root: string,
): Promise<Result<string[][], SyncReason>> => {
  const listed = await functions.runGit([
    '-C',
    root,
    'rev-list',
    '--first-parent',
    '--merges',
    '--parents',
    'HEAD',
  ]);

  if (!listed.ok) {
    return failed(listed.reason.message);
  }

  const merges = listed.value
    .split('\n')
    .filter((line) => line !== '')
    .map((line) =>
      line
        .split(' ')
        .filter((part) => part !== '')
        .slice(1),
    );

  return { ok: true, value: merges };
};

const readMerge = async (
  functions: GitFunctions,
  root: string,
  parents: string[],
  renamedPath: string,
): Promise<Result<MergeSides | undefined | 'skip' | 'pending', SyncReason>> => {
  const [local, remote] = parents;

  if (local === undefined || remote === undefined) {
    return { ok: true, value: undefined };
  }

  const localPaths = await listPaths(functions, root, local, renamedPath);

  if (!localPaths.ok) {
    return localPaths;
  }

  const remotePaths = await listPaths(functions, root, remote, renamedPath);

  if (!remotePaths.ok) {
    return remotePaths;
  }

  const localHas = localPaths.value.length > 0;
  const remoteHas = remotePaths.value.length > 0;

  if (localHas && remoteHas) {
    return { ok: true, value: 'skip' };
  }

  if (!localHas && !remoteHas) {
    return { ok: true, value: 'pending' };
  }

  if (remoteHas) {
    return { ok: true, value: { renamed: remote, surviving: local } };
  }

  return { ok: true, value: { renamed: local, surviving: remote } };
};

const clashSides = async (
  functions: GitFunctions,
  root: string,
  renamedPath: string,
): Promise<Result<ClashSides | 'pending' | undefined, SyncReason>> => {
  const merges = await firstParentMerges(functions, root);

  if (!merges.ok) {
    return merges;
  }

  const [newest = []] = merges.value;

  for (const parents of merges.value) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each merge is read only if the newer ones are skipped.
    const reading = await readMerge(functions, root, parents, renamedPath);

    if (!reading.ok) {
      return reading;
    }

    if (reading.value === 'skip') {
      continue;
    }

    if (reading.value === undefined || reading.value === 'pending') {
      return { ok: true, value: reading.value };
    }

    const sideIndex = parents[0] === reading.value.renamed ? 0 : 1;

    return {
      ok: true,
      value: { ...reading.value, tip: newest[sideIndex] ?? reading.value.renamed },
    };
  }

  return { ok: true, value: undefined };
};

// Like the cache, a last piece with no newline is not a line yet.
const readLines = async (
  functions: GitFunctions,
  root: string,
  revision: string,
  path: string,
): Promise<Result<string[], SyncReason>> => {
  const shown = await functions.runGit(['-C', root, 'show', `${revision}:${path}`]);

  if (!shown.ok) {
    return failed(shown.reason.message);
  }

  const lines = shown.value.split('\n');

  lines.pop();

  return { ok: true, value: lines };
};

const optionalLinesOf = (
  functions: GitFunctions,
  root: string,
  revision: string,
  path: string,
  paths: string[],
): Promise<Result<string[], SyncReason>> =>
  paths.includes(path)
    ? readLines(functions, root, revision, path)
    : Promise.resolve({ ok: true, value: [] });

const commonPrefixLength = (left: string[], right: string[]): number => {
  let length = 0;

  while (length < left.length && left[length] === right[length]) {
    length += 1;
  }

  return length;
};

// The lines from `start` on that have the clashing ID, named by file and 1-based line.
const referencesFrom = (
  path: string,
  lines: string[],
  from: TicketId,
  start: number,
): MovedFactReference[] =>
  lines.flatMap((text, index) => {
    const parsed = parseFactLine(text);

    return index >= start && parsed.ok && parsed.value.ticket === from
      ? [{ path: relative(factsFolder, path), line: index + 1 }]
      : [];
  });

// Lines on the newest parent of the renamed side that come after the lines both sides shared at the
// merge that brought the file in, and that have the clashing ID.
const movedLinesOf = async (
  functions: GitFunctions,
  root: string,
  sides: ClashSides,
  paths: SidePaths,
  path: string,
  from: TicketId,
): Promise<Result<MovedFactReference[], SyncReason>> => {
  const renamedLines = await optionalLinesOf(functions, root, sides.renamed, path, paths.renamed);

  if (!renamedLines.ok) {
    return renamedLines;
  }

  const survivingLines = await optionalLinesOf(
    functions,
    root,
    sides.surviving,
    path,
    paths.surviving,
  );

  if (!survivingLines.ok) {
    return survivingLines;
  }

  const tipLines = await readLines(functions, root, sides.tip, path);

  if (!tipLines.ok) {
    return tipLines;
  }

  const shared = commonPrefixLength(renamedLines.value, survivingLines.value);

  return { ok: true, value: referencesFrom(path, tipLines.value, from, shared) };
};

const collectReferences = (
  perFile: Result<MovedFactReference[], SyncReason>[],
): Result<MovedFactReference[], SyncReason> => {
  const references: MovedFactReference[] = [];

  for (const file of perFile) {
    if (!file.ok) {
      return file;
    }

    references.push(...file.value);
  }

  return { ok: true, value: references };
};

// An uncommitted ticket file exists only on this machine. Its facts are the old-ID lines this
// machine wrote, read from HEAD, because a merge parent can be the other clone's side. Lines that
// this machine wrote after it merged the other ticket, and before the rename, are included too.
const pendingReferences = async (
  functions: GitFunctions,
  root: string,
  from: TicketId,
  localMachine: string | undefined,
): Promise<Result<MovedFactReference[], SyncReason>> => {
  if (localMachine === undefined) {
    return failed("Cannot read this machine's name for the pending ticket's facts.");
  }

  const machinePaths = await listPaths(functions, root, 'HEAD', join(factsFolder, localMachine));

  if (!machinePaths.ok) {
    return machinePaths;
  }

  const jsonlPaths = machinePaths.value.filter((path) => path.endsWith('.jsonl'));

  const perFile = await Promise.all(
    jsonlPaths.map(async (path) => {
      const lines = await readLines(functions, root, 'HEAD', path);

      return lines.ok
        ? { ok: true as const, value: referencesFrom(path, lines.value, from, 0) }
        : lines;
    }),
  );

  return collectReferences(perFile);
};

// The `path:line` keys that one fact line moves, when it is an alias.
const movedKeysOf = (text: string): string[] => {
  const parsed = parseFactLine(text);

  if (!parsed.ok || parsed.value.kind !== 'alias') {
    return [];
  }

  return (parsed.value.movedFacts ?? []).map((reference) => `${reference.path}:${reference.line}`);
};

// Lines an alias on HEAD already moves belong to that alias's ticket now. A later clash must not
// move them again, or the earlier renamed ticket would lose them.
const alreadyMovedKeys = async (
  functions: GitFunctions,
  root: string,
): Promise<Result<Set<string>, SyncReason>> => {
  const paths = await listPaths(functions, root, 'HEAD', factsFolder);

  if (!paths.ok) {
    return paths;
  }

  const moved = new Set<string>();

  for (const path of paths.value.filter((entry) => entry.endsWith('.jsonl'))) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each fact file is read in turn.
    const lines = await readLines(functions, root, 'HEAD', path);

    if (!lines.ok) {
      return lines;
    }

    for (const key of lines.value.flatMap(movedKeysOf)) {
      moved.add(key);
    }
  }

  return { ok: true, value: moved };
};

const ownedReferences = async (
  functions: GitFunctions,
  root: string,
  renamedPath: string,
  from: TicketId,
  localMachine: string | undefined,
): Promise<Result<MovedFactReference[], SyncReason>> => {
  // A ticket file that HEAD lacks is uncommitted, so it is pending even when no merge is on HEAD.
  const inHead = await listPaths(functions, root, 'HEAD', renamedPath);

  if (!inHead.ok) {
    return inHead;
  }

  if (inHead.value.length === 0) {
    return pendingReferences(functions, root, from, localMachine);
  }

  const sides = await clashSides(functions, root, renamedPath);

  if (!sides.ok) {
    return sides;
  }

  if (sides.value === undefined) {
    return { ok: true, value: [] };
  }

  if (sides.value === 'pending') {
    return pendingReferences(functions, root, from, localMachine);
  }

  const clashSidesValue = sides.value;
  const tipPaths = await listPaths(functions, root, clashSidesValue.tip, factsFolder);

  if (!tipPaths.ok) {
    return tipPaths;
  }

  const renamedPaths = await listPaths(functions, root, clashSidesValue.renamed, factsFolder);

  if (!renamedPaths.ok) {
    return renamedPaths;
  }

  const survivingPaths = await listPaths(functions, root, clashSidesValue.surviving, factsFolder);

  if (!survivingPaths.ok) {
    return survivingPaths;
  }

  const paths: SidePaths = { renamed: renamedPaths.value, surviving: survivingPaths.value };
  const jsonlPaths = tipPaths.value.filter((path) => path.endsWith('.jsonl'));

  const perFile = await Promise.all(
    jsonlPaths.map((path) => movedLinesOf(functions, root, clashSidesValue, paths, path, from)),
  );

  return collectReferences(perFile);
};

export const movedFactReferences = async (
  functions: GitFunctions,
  root: string,
  renamedPath: string,
  from: TicketId,
  localMachine: string | undefined,
): Promise<Result<MovedFactReference[], SyncReason>> => {
  const moved = await alreadyMovedKeys(functions, root);

  if (!moved.ok) {
    return moved;
  }

  const owned = await ownedReferences(functions, root, renamedPath, from, localMachine);

  if (!owned.ok) {
    return owned;
  }

  return {
    ok: true,
    value: owned.value.filter(
      (reference) => !moved.value.has(`${reference.path}:${reference.line}`),
    ),
  };
};
