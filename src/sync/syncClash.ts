import { join, relative } from 'node:path';

import type { Result } from '../result.ts';
import { parseProjectName, parseTicketFileName, parseTicketId } from '../ticket/ticket.ts';
import type { ProjectName, TicketId } from '../ticket/ticket.ts';
import { movedFactReferences } from './syncClashFacts.ts';
import type { MovedFactReference } from './syncClashFacts.ts';
import { resetIndex, stageRemoval, stageText } from './syncCommit.ts';
import type { SyncCommitFunctions, SyncReason } from './syncCommit.ts';

export interface SyncClashFunctions extends SyncCommitFunctions {
  readdir: (directory: string) => Promise<string[]>;
  rename: (from: string, to: string) => Promise<void>;
  // Fails with EEXIST when the new path exists.
  link: (existingPath: string, newPath: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  randomIdSuffix: () => string;
  appendAlias: (alias: AliasRecord) => Promise<Result<{ path: string }, { message: string }>>;
  // The alias facts this machine has written.
  listAliases: () => Promise<{ from: string; to: string; path: string }[]>;
}

interface AliasRecord {
  ticket: TicketId;
  from: TicketId;
  at: string;
  movedFacts: MovedFactReference[];
}

export interface SyncAlias {
  from: TicketId;
  to: TicketId;
  path: string;
}

interface ProjectFile {
  fileName: string;
  id: TicketId;
  slug: string;
}

interface DatedFile {
  file: ProjectFile;
  // `undefined` when no commit added the file yet, which makes it the newest.
  addedAt: number | undefined;
}

interface MovedPath {
  from: string;
  to: string;
  // False for a file no commit added, which stays out of the clash commit.
  tracked: boolean;
}

export interface ClashResolution {
  aliases: SyncAlias[];
  moves: MovedPath[];
}

interface FolderMove {
  from: string;
  to: string;
  files: MovedPath[];
}

interface Renames extends ClashResolution {
  factPaths: string[];
  folders: FolderMove[];
}

const maxIdAttempts = 100;

const failed = (message: string): { ok: false; reason: SyncReason } => ({
  ok: false,
  reason: { kind: 'failed', message },
});

const allMoves = (renames: Renames): MovedPath[] => [
  ...renames.moves,
  ...renames.folders.flatMap((folder) => folder.files),
];

const listNames = async (functions: SyncClashFunctions, directory: string): Promise<string[]> => {
  try {
    return await functions.readdir(directory);
  } catch {
    return [];
  }
};

const listProjectFiles = async (
  functions: SyncClashFunctions,
  root: string,
  project: ProjectName,
): Promise<ProjectFile[]> => {
  const names = await listNames(functions, join(root, 'tickets', project));
  const files: ProjectFile[] = [];

  for (const fileName of names) {
    const parsed = parseTicketFileName(fileName, project);

    if (parsed.ok) {
      files.push({ fileName, ...parsed.value });
    }
  }

  return files;
};

const addedAt = async (
  functions: SyncClashFunctions,
  root: string,
  path: string,
): Promise<number | undefined> => {
  const log = await functions.runGit([
    '-C',
    root,
    'log',
    '--diff-filter=A',
    '--format=%ct',
    '--',
    path,
  ]);

  const first = log.ok ? log.value.split('\n')[0] : undefined;

  if (first === '') {
    return undefined;
  }

  const seconds = Number(first);

  return Number.isFinite(seconds) ? seconds : undefined;
};

const byAge = (left: DatedFile, right: DatedFile): number => {
  const leftTime = left.addedAt ?? Number.POSITIVE_INFINITY;
  const rightTime = right.addedAt ?? Number.POSITIVE_INFINITY;

  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return left.file.fileName < right.file.fileName ? -1 : 1;
};

const datedGroup = (
  functions: SyncClashFunctions,
  root: string,
  project: ProjectName,
  group: ProjectFile[],
): Promise<DatedFile[]> =>
  Promise.all(
    group.map(async (file) => ({
      file,
      addedAt: await addedAt(functions, root, join('tickets', project, file.fileName)),
    })),
  );

const newerClashingFiles = async (
  functions: SyncClashFunctions,
  root: string,
  project: ProjectName,
  files: ProjectFile[],
): Promise<DatedFile[]> => {
  const groups = new Map<string, ProjectFile[]>();

  for (const file of files) {
    groups.set(file.id, [...(groups.get(file.id) ?? []), file]);
  }

  const clashes = [...groups.values()].filter((group) => group.length > 1);

  const dated = await Promise.all(
    clashes.map((group) => datedGroup(functions, root, project, group)),
  );

  return dated.flatMap((group) => group.toSorted(byAge).slice(1));
};

const freeId = (
  functions: SyncClashFunctions,
  project: ProjectName,
  taken: Set<string>,
): TicketId | undefined => {
  for (let attempt = 0; attempt < maxIdAttempts; attempt += 1) {
    const parsed = parseTicketId(`${project}-${functions.randomIdSuffix()}`);

    if (parsed.ok && !taken.has(parsed.value)) {
      return parsed.value;
    }
  }

  return undefined;
};

// One clash gets one alias, even when an earlier sync wrote the fact and failed to commit the rename.
const reusableId = async (
  functions: SyncClashFunctions,
  project: ProjectName,
  file: ProjectFile,
  taken: Set<string>,
): Promise<{ id: TicketId; path: string } | undefined> => {
  const aliases = await functions.listAliases();

  for (const alias of aliases) {
    const parsed = parseTicketId(alias.to);
    const isOwnAlias = alias.from === file.id && alias.to.startsWith(`${project}-`);

    if (isOwnAlias && parsed.ok && !taken.has(parsed.value)) {
      return { id: parsed.value, path: alias.path };
    }
  }

  return undefined;
};

// A reused alias already has its fact, so only a new alias appends one.
const aliasFactPath = async (
  functions: SyncClashFunctions,
  root: string,
  record: {
    ticket: TicketId;
    from: TicketId;
    renamedPath: string;
    reusedPath: string | undefined;
  },
): Promise<Result<string, SyncReason>> => {
  if (record.reusedPath !== undefined) {
    return { ok: true, value: record.reusedPath };
  }

  const at = new Date(functions.now()).toISOString();
  const movedFacts = await movedFactReferences(functions, root, record.renamedPath, record.from);

  if (!movedFacts.ok) {
    return movedFacts;
  }

  const appended = await functions.appendAlias({
    ticket: record.ticket,
    from: record.from,
    at,
    movedFacts: movedFacts.value,
  });

  return appended.ok
    ? { ok: true, value: relative(root, appended.value.path) }
    : failed(appended.reason.message);
};

const renameFile = async (
  functions: SyncClashFunctions,
  root: string,
  project: ProjectName,
  file: ProjectFile,
  taken: Set<string>,
): Promise<Result<{ alias: SyncAlias; factPath: string }, SyncReason>> => {
  const reused = await reusableId(functions, project, file, taken);
  const to = reused?.id ?? freeId(functions, project, taken);

  if (to === undefined) {
    return failed(`No free ticket ID found for project "${project}".`);
  }

  taken.add(to);

  const from = join('tickets', project, file.fileName);

  const fact = await aliasFactPath(functions, root, {
    ticket: to,
    from: file.id,
    renamedPath: from,
    reusedPath: reused?.path,
  });

  if (!fact.ok) {
    return fact;
  }

  const path = join('tickets', project, `${to}-${file.slug}.md`);

  try {
    await functions.rename(join(root, from), join(root, path));
  } catch {
    return failed(`Cannot rename ${from} to ${path}.`);
  }

  return { ok: true, value: { alias: { from: file.id, to, path }, factPath: fact.value } };
};

const folderIds = async (
  functions: SyncClashFunctions,
  root: string,
  project: ProjectName,
): Promise<string[]> => {
  const names = await listNames(functions, join(root, 'tickets', project));

  return names.flatMap((name) => {
    const parsed = parseTicketId(name);

    return parsed.ok ? [parsed.value] : [];
  });
};

const folderExists = async (
  functions: SyncClashFunctions,
  folder: string,
): Promise<Result<boolean, SyncReason>> => {
  try {
    await functions.readdir(folder);

    return { ok: true, value: true };
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';

    return missing ? { ok: true, value: false } : failed(`Cannot read ${folder}.`);
  }
};

// A repository with no commit yet tracks no file, and Git fails for it.
const trackedFolderFiles = async (
  functions: SyncClashFunctions,
  root: string,
  folder: string,
): Promise<string[]> => {
  const listed = await functions.runGit([
    '-C',
    root,
    'ls-tree',
    '-r',
    '-z',
    '--name-only',
    'HEAD',
    '--',
    folder,
  ]);

  return listed.ok ? listed.value.split('\0').filter((path) => path !== '') : [];
};

const renameFolder = async (
  functions: SyncClashFunctions,
  root: string,
  project: ProjectName,
  alias: SyncAlias,
  renames: Renames,
): Promise<Result<undefined, SyncReason>> => {
  const from = join('tickets', project, alias.from);
  const to = join('tickets', project, alias.to);
  const exists = await folderExists(functions, join(root, from));

  if (!exists.ok) {
    return exists;
  }

  if (!exists.value) {
    return { ok: true, value: undefined };
  }

  const tracked = await trackedFolderFiles(functions, root, from);

  try {
    await functions.rename(join(root, from), join(root, to));
  } catch {
    return failed(`Cannot rename ${from} to ${to}.`);
  }

  renames.folders.push({
    from,
    to,
    files: tracked.map((path) => ({
      from: path,
      to: join(to, relative(from, path)),
      tracked: true,
    })),
  });

  return { ok: true, value: undefined };
};

// Adds each rename to `renames` as it happens, so a failure leaves the caller a full list to undo.
const renameClashes = async (
  functions: SyncClashFunctions,
  root: string,
  project: ProjectName,
  renames: Renames,
): Promise<Result<undefined, SyncReason>> => {
  const files = await listProjectFiles(functions, root, project);
  const folderNames = await folderIds(functions, root, project);
  const taken = new Set<string>([...files.map((file) => file.id), ...folderNames]);
  const clashing = await newerClashingFiles(functions, root, project, files);

  for (const { file, addedAt: addedTime } of clashing) {
    // Renames run one at a time, since each new ID must differ from the ones chosen before it.
    // oxlint-disable-next-line eslint/no-await-in-loop -- See above.
    const renamed = await renameFile(functions, root, project, file, taken);

    if (!renamed.ok) {
      return renamed;
    }

    const { alias, factPath } = renamed.value;

    renames.aliases.push(alias);

    renames.moves.push({
      from: join('tickets', project, file.fileName),
      to: alias.path,
      tracked: addedTime !== undefined,
    });

    renames.factPaths.push(factPath);

    // oxlint-disable-next-line eslint/no-await-in-loop -- See above.
    const folder = await renameFolder(functions, root, project, alias, renames);

    if (!folder.ok) {
      return folder;
    }
  }

  return { ok: true, value: undefined };
};

const stageMove = async (
  functions: SyncClashFunctions,
  root: string,
  move: MovedPath,
): Promise<Result<undefined, SyncReason>> => {
  const listed = await functions.runGit(['-C', root, 'ls-tree', 'HEAD', '--', move.from]);

  if (!listed.ok) {
    return failed(listed.reason.message);
  }

  const [mode, , blobId] = listed.value.trim().split(/\s+/);

  if (blobId === undefined) {
    return failed(`${move.from} is not in HEAD.`);
  }

  const added = await functions.runGit([
    '-C',
    root,
    'update-index',
    '--add',
    '--cacheinfo',
    `${mode},${blobId},${move.to}`,
  ]);

  if (!added.ok) {
    return failed(added.reason.message);
  }

  return stageRemoval(functions, root, move.from);
};

// The commit holds the renames of tracked files from `HEAD`, and the alias facts as they are on
// disk, so a rename and its fact are committed together.
const stageClashes = async (
  functions: SyncClashFunctions,
  root: string,
  renames: Renames,
): Promise<Result<undefined, SyncReason>> => {
  const reset = await resetIndex(functions, root);

  if (!reset.ok) {
    return reset;
  }

  for (const move of allMoves(renames).filter((entry) => entry.tracked)) {
    // Each call rewrites the index file, so they run one at a time.
    // oxlint-disable-next-line eslint/no-await-in-loop -- See above.
    const staged = await stageMove(functions, root, move);

    if (!staged.ok) {
      return staged;
    }
  }

  for (const factPath of new Set(renames.factPaths)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- See above.
    const text = await functions.readFile(join(root, factPath)).catch(() => undefined);

    if (text === undefined) {
      return failed(`Cannot read ${factPath}.`);
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- See above.
    const staged = await stageText(functions, root, factPath, text);

    if (!staged.ok) {
      return staged;
    }
  }

  return { ok: true, value: undefined };
};

const commitClashes = async (
  functions: SyncClashFunctions,
  root: string,
  renames: Renames,
): Promise<Result<undefined, SyncReason>> => {
  const staged = await stageClashes(functions, root, renames);

  if (!staged.ok) {
    return staged;
  }

  const options = await functions.commitArguments(root);

  const committed = await functions.runGit([
    ...options,
    '-C',
    root,
    'commit',
    '--quiet',
    '-m',
    'Give clashing ticket IDs new IDs',
  ]);

  return committed.ok ? { ok: true, value: undefined } : failed(committed.reason.message);
};

const restoreFolder = async (
  functions: SyncClashFunctions,
  root: string,
  folder: FolderMove,
): Promise<void> => {
  const exists = await folderExists(functions, join(root, folder.from));

  const absent = exists.ok && !exists.value;

  if (!absent) {
    return;
  }

  await functions.rename(join(root, folder.to), join(root, folder.from)).catch(() => undefined);
};

const undoMoves = async (
  functions: SyncClashFunctions,
  root: string,
  renames: Renames,
): Promise<void> => {
  await Promise.all(renames.folders.map((folder) => restoreFolder(functions, root, folder)));

  await Promise.all(
    renames.moves.map(async (move) => {
      const to = join(root, move.to);

      // `link` fails when the old path exists, so a save there is never replaced.
      try {
        await functions.link(to, join(root, move.from));
      } catch {
        return;
      }

      await functions.unlink(to).catch(() => undefined);
    }),
  );
};

// The caller holds the store lock and has just merged. A new ID is free in the whole project
// folder, so one folder never holds two files with one ID afterwards. The renames of tracked files
// and their alias facts are committed as one commit, or the renames are undone.
export const resolveIdClashes = async (
  functions: SyncClashFunctions,
  root: string,
): Promise<Result<ClashResolution, SyncReason>> => {
  const names = await listNames(functions, join(root, 'tickets'));
  const projects = names.map((name) => parseProjectName(name)).filter((parsed) => parsed.ok);
  const renames: Renames = { aliases: [], moves: [], factPaths: [], folders: [] };

  let failure: SyncReason | undefined;

  for (const project of projects) {
    // Projects run one at a time, so a failed rename stops the rest.
    // oxlint-disable-next-line eslint/no-await-in-loop -- See above.
    const renamed = await renameClashes(functions, root, project.value, renames);

    if (!renamed.ok) {
      failure = renamed.reason;

      break;
    }
  }

  if (failure !== undefined) {
    await undoMoves(functions, root, renames);

    return { ok: false, reason: failure };
  }

  const resolution = { aliases: renames.aliases, moves: allMoves(renames) };

  if (renames.aliases.length === 0) {
    return { ok: true, value: resolution };
  }

  const committed = await commitClashes(functions, root, renames);

  if (!committed.ok) {
    await undoMoves(functions, root, renames);

    return committed;
  }

  return { ok: true, value: resolution };
};
