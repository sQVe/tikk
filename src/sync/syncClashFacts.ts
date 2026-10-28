import { basename, join, relative } from 'node:path';

import { parseFactLine } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import type { TicketId } from '../ticket/ticket.ts';
import type { SyncCommitFunctions, SyncReason } from './syncCommit.ts';
import { readFolderNames } from './syncCommit.ts';

export interface MovedFactReference {
  path: string;
  line: number;
}

type GitFunctions = Pick<SyncCommitFunctions, 'runGit' | 'readFile'> & {
  readdir: (directory: string) => Promise<string[]>;
};

interface MergeSides {
  renamed: string;
  surviving: string;
}

interface ClashSides extends MergeSides {
  tip: string;
  // True when this machine holds the renamed ticket, so its fact files may hold lines Git lacks.
  renamedIsLocal: boolean;
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
      value: {
        ...reading.value,
        tip: newest[sideIndex] ?? reading.value.renamed,
        renamedIsLocal: parents[0] === reading.value.renamed,
      },
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

// The machine's own fact files as they are on disk. A held-back alias line is on disk before Git has
// it, and the clash commit stages these files from disk, so their line numbers are the ones Git gets.
const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const ownDiskLines = async (
  functions: GitFunctions,
  root: string,
  localMachine: string,
): Promise<Result<Map<string, string[]>, SyncReason>> => {
  const folder = join(factsFolder, localMachine);

  const listed = await functions.readdir(join(root, folder)).then(
    (names) => ({ ok: true as const, value: names }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  if (!listed.ok) {
    // A machine with no fact file yet has no folder. Any other failure leaves its lines unknown.
    return isMissing(listed.error)
      ? { ok: true, value: new Map<string, string[]>() }
      : failed(`Cannot read ${folder}.`);
  }

  const names = listed.value;
  const lines = new Map<string, string[]>();

  for (const name of names.filter((entry) => entry.endsWith('.jsonl'))) {
    const path = join(folder, name);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each fact file is read in turn.
    const text = await functions.readFile(join(root, path)).catch(() => undefined);

    if (text === undefined) {
      return failed(`Cannot read ${path}.`);
    }

    const pieces = text.split('\n');

    pieces.pop();
    lines.set(path, pieces);
  }

  return { ok: true, value: lines };
};

const renamedOwnLines = (
  functions: GitFunctions,
  root: string,
  sides: ClashSides,
  localMachine: string | undefined,
): Promise<Result<Map<string, string[]>, SyncReason>> =>
  sides.renamedIsLocal && localMachine !== undefined
    ? ownDiskLines(functions, root, localMachine)
    : Promise.resolve({ ok: true, value: new Map<string, string[]>() });

// The renamed side's lines. Its own fact files come from disk, since they can hold lines Git lacks.
const renamedLinesOf = (
  functions: GitFunctions,
  root: string,
  sides: ClashSides,
  paths: SidePaths,
  path: string,
  own: Map<string, string[]>,
): Promise<Result<string[], SyncReason>> => {
  const ownLines = own.get(path);

  return ownLines === undefined
    ? optionalLinesOf(functions, root, sides.renamed, path, paths.renamed)
    : Promise.resolve({ ok: true, value: ownLines });
};

const tipLinesOf = (
  functions: GitFunctions,
  root: string,
  sides: ClashSides,
  path: string,
  own: Map<string, string[]>,
): Promise<Result<string[], SyncReason>> => {
  const ownLines = own.get(path);

  return ownLines === undefined
    ? readLines(functions, root, sides.tip, path)
    : Promise.resolve({ ok: true, value: ownLines });
};

const movedLinesOf = async (
  functions: GitFunctions,
  root: string,
  sides: ClashSides,
  paths: SidePaths,
  path: string,
  from: TicketId,
  own: Map<string, string[]>,
): Promise<Result<MovedFactReference[], SyncReason>> => {
  const renamedLines = await renamedLinesOf(functions, root, sides, paths, path, own);

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

  const tipLines = await tipLinesOf(functions, root, sides, path, own);

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

const pendingReferences = async (
  functions: GitFunctions,
  root: string,
  from: TicketId,
  localMachine: string | undefined,
): Promise<Result<MovedFactReference[], SyncReason>> => {
  if (localMachine === undefined) {
    return failed("Cannot read this machine's name for the pending ticket's facts.");
  }

  const own = await ownDiskLines(functions, root, localMachine);

  if (!own.ok) {
    return own;
  }

  return {
    ok: true,
    value: [...own.value].flatMap(([path, lines]) => referencesFrom(path, lines, from, 0)),
  };
};

// The keys one fact line moves. An alias whose new ticket is not in HEAD moves nothing: its clash
// was abandoned, so its lines are not owned by another ticket.
const movedKeysOf = (text: string, headTicketPaths: string[]): string[] => {
  const parsed = parseFactLine(text);

  if (!parsed.ok || parsed.value.kind !== 'alias') {
    return [];
  }

  const ticket = parsed.value.ticket;

  if (!headTicketPaths.some((path) => basename(path).startsWith(`${ticket}-`))) {
    return [];
  }

  return (parsed.value.movedFacts ?? []).map((reference) => `${reference.path}:${reference.line}`);
};

const alreadyMovedKeys = async (
  functions: GitFunctions,
  root: string,
): Promise<Result<Set<string>, SyncReason>> => {
  const paths = await listPaths(functions, root, 'HEAD', factsFolder);

  if (!paths.ok) {
    return paths;
  }

  const headTickets = await listPaths(functions, root, 'HEAD', 'tickets');

  if (!headTickets.ok) {
    return headTickets;
  }

  const moved = new Set<string>();

  for (const path of paths.value.filter((entry) => entry.endsWith('.jsonl'))) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each fact file is read in turn.
    const lines = await readLines(functions, root, 'HEAD', path);

    if (!lines.ok) {
      return lines;
    }

    for (const key of lines.value.flatMap((text) => movedKeysOf(text, headTickets.value))) {
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
  const own = await renamedOwnLines(functions, root, clashSidesValue, localMachine);

  if (!own.ok) {
    return own;
  }

  const gitPaths = tipPaths.value.filter((path) => path.endsWith('.jsonl'));
  const jsonlPaths = [...new Set([...gitPaths, ...own.value.keys()])];

  const perFile = await Promise.all(
    jsonlPaths.map((path) =>
      movedLinesOf(functions, root, clashSidesValue, paths, path, from, own.value),
    ),
  );

  return collectReferences(perFile);
};

const aliasTicketOf = (text: string): string[] => {
  const parsed = parseFactLine(text);

  return parsed.ok && parsed.value.kind === 'alias' ? [parsed.value.ticket] : [];
};

// The new ID of every alias in the store, from every machine's fact files on disk.
export const aliasDestinations = async (
  functions: GitFunctions,
  root: string,
): Promise<Result<string[], SyncReason>> => {
  const machines = await readFolderNames(functions, join(root, factsFolder));

  if (!machines.ok) {
    return machines;
  }

  const destinations: string[] = [];

  for (const machine of machines.value.filter((name) => !name.endsWith('.jsonl'))) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each machine folder is read in turn.
    const names = await readFolderNames(functions, join(root, factsFolder, machine));

    if (!names.ok) {
      return names;
    }

    for (const name of names.value.filter((entry) => entry.endsWith('.jsonl'))) {
      const path = join(root, factsFolder, machine, name);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each fact file is read in turn.
      const text = await functions.readFile(path).catch(() => undefined);

      if (text === undefined) {
        return failed(`Cannot read ${path}.`);
      }

      destinations.push(...text.split('\n').flatMap(aliasTicketOf));
    }
  }

  return { ok: true, value: destinations };
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

const namesAlias = (fact: { ticket: string; from: string }, alias: { from: string; to: string }) =>
  fact.ticket === alias.to && fact.from === alias.from;

// True when HEAD's fact file already holds this alias line.
export const isCommittedAlias = async (
  functions: GitFunctions,
  root: string,
  alias: { from: string; to: string; path: string },
): Promise<Result<boolean, SyncReason>> => {
  const shown = await functions.runGit(['-C', root, 'show', `HEAD:${alias.path}`]);

  if (!shown.ok) {
    const paths = await listPaths(functions, root, 'HEAD', alias.path);

    if (!paths.ok) {
      return paths;
    }

    return paths.value.length === 0 ? { ok: true, value: false } : failed(shown.reason.message);
  }

  const committed = shown.value.split('\n').some((text) => {
    const parsed = parseFactLine(text);

    return parsed.ok && parsed.value.kind === 'alias' && namesAlias(parsed.value, alias);
  });

  return { ok: true, value: committed };
};
