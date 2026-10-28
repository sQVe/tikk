import { relative } from 'node:path';

import { parseFactLine } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import type { TicketId } from '../ticket/ticket.ts';
import type { SyncCommitFunctions, SyncReason } from './syncCommit.ts';

export interface MovedFactReference {
  // The fact file under the facts folder, such as `machine/2026-10.jsonl`.
  path: string;
  line: number;
}

type GitFunctions = Pick<SyncCommitFunctions, 'runGit'>;

interface ClashSides {
  // The merge side that holds the renamed ticket's facts.
  renamed: string;
  surviving: string;
}

const factsFolder = 'facts';

const failed = (message: string): { ok: false; reason: SyncReason } => ({
  ok: false,
  reason: { kind: 'failed', message },
});

// A path that no revision has gives an empty list. A failed Git call is an error, not an empty list.
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

// The merges on HEAD's first-parent line, newest first. Local commits made after a merge stay on
// that line, so a retry that comes after them still finds the merge. The first parent is the local
// side, and the second is the remote side.
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

// A later merge can carry the renamed file along on both sides, so a merge where both parents hold
// it says nothing about who brought it in. Returns `skip` for that merge.
const readMerge = async (
  functions: GitFunctions,
  root: string,
  parents: string[],
  renamedPath: string,
): Promise<Result<ClashSides | undefined | 'skip', SyncReason>> => {
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

  if (remoteHas) {
    return { ok: true, value: { renamed: remote, surviving: local } };
  }

  return { ok: true, value: { renamed: local, surviving: remote } };
};

// A file that neither parent has is not committed yet, so the nearest merge with no holder decides
// that only this machine can hold its facts.
const clashSides = async (
  functions: GitFunctions,
  root: string,
  renamedPath: string,
): Promise<Result<ClashSides | undefined, SyncReason>> => {
  const merges = await firstParentMerges(functions, root);

  if (!merges.ok) {
    return merges;
  }

  for (const parents of merges.value) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each merge is read only if the newer ones are skipped.
    const reading = await readMerge(functions, root, parents, renamedPath);

    if (!reading.ok) {
      return reading;
    }

    if (reading.value !== 'skip') {
      return { ok: true, value: reading.value };
    }
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

const survivingLinesOf = (
  functions: GitFunctions,
  root: string,
  sides: ClashSides,
  path: string,
  survivingPaths: string[],
): Promise<Result<string[], SyncReason>> =>
  survivingPaths.includes(path)
    ? readLines(functions, root, sides.surviving, path)
    : Promise.resolve({ ok: true, value: [] });

const commonPrefixLength = (left: string[], right: string[]): number => {
  let length = 0;

  while (length < left.length && left[length] === right[length]) {
    length += 1;
  }

  return length;
};

// Lines the renamed side adds past the lines both sides share, and that have the clashing ID.
const movedLinesOf = async (
  functions: GitFunctions,
  root: string,
  sides: ClashSides,
  path: string,
  from: TicketId,
  survivingPaths: string[],
): Promise<Result<MovedFactReference[], SyncReason>> => {
  const renamedLines = await readLines(functions, root, sides.renamed, path);

  if (!renamedLines.ok) {
    return renamedLines;
  }

  const survivingLines = await survivingLinesOf(functions, root, sides, path, survivingPaths);

  if (!survivingLines.ok) {
    return survivingLines;
  }

  const shared = commonPrefixLength(renamedLines.value, survivingLines.value);
  const references: MovedFactReference[] = [];

  for (const [index, text] of renamedLines.value.entries()) {
    const parsed = parseFactLine(text);

    if (index >= shared && parsed.ok && parsed.value.ticket === from) {
      references.push({ path: relative(factsFolder, path), line: index + 1 });
    }
  }

  return { ok: true, value: references };
};

// Facts with the clashing ID that only the renamed ticket's side has. The surviving side keeps the
// rest, so its facts stay on the old ID.
export const movedFactReferences = async (
  functions: GitFunctions,
  root: string,
  renamedPath: string,
  from: TicketId,
): Promise<Result<MovedFactReference[], SyncReason>> => {
  const sides = await clashSides(functions, root, renamedPath);

  if (!sides.ok) {
    return sides;
  }

  if (sides.value === undefined) {
    return { ok: true, value: [] };
  }

  const clashSidesValue = sides.value;
  const renamedPaths = await listPaths(functions, root, clashSidesValue.renamed, factsFolder);

  if (!renamedPaths.ok) {
    return renamedPaths;
  }

  const survivingPaths = await listPaths(functions, root, clashSidesValue.surviving, factsFolder);

  if (!survivingPaths.ok) {
    return survivingPaths;
  }

  const jsonlPaths = renamedPaths.value.filter((path) => path.endsWith('.jsonl'));

  const perFile = await Promise.all(
    jsonlPaths.map((path) =>
      movedLinesOf(functions, root, clashSidesValue, path, from, survivingPaths.value),
    ),
  );

  const references: MovedFactReference[] = [];

  for (const file of perFile) {
    if (!file.ok) {
      return file;
    }

    references.push(...file.value);
  }

  return { ok: true, value: references };
};
