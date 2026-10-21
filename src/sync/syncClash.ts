import { join } from 'node:path';

import type { Result } from '../result.ts';
import { commitArguments } from '../store/store.ts';
import { parseProjectName, parseTicketFileName, parseTicketId } from '../ticket/ticket.ts';
import type { ProjectName, TicketId } from '../ticket/ticket.ts';
import type { SyncCommitFunctions, SyncReason } from './syncCommit.ts';

export interface SyncClashFunctions extends SyncCommitFunctions {
  readdir: (directory: string) => Promise<string[]>;
  rename: (from: string, to: string) => Promise<void>;
  randomIdSuffix: () => string;
  appendAlias: (alias: AliasRecord) => Promise<Result<{ path: string }, { message: string }>>;
}

interface AliasRecord {
  ticket: TicketId;
  from: TicketId;
  at: string;
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

interface ProjectRenames {
  aliases: SyncAlias[];
  factPaths: string[];
}

const maxIdAttempts = 100;

const failed = (message: string): { ok: false; reason: SyncReason } => ({
  ok: false,
  reason: { kind: 'failed', message },
});

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

  if (first === undefined || first === '') {
    return undefined;
  }

  const seconds = Number(first);

  return Number.isFinite(seconds) ? seconds : undefined;
};

const byAge = (left: DatedFile, right: DatedFile): number => {
  if (left.addedAt !== right.addedAt) {
    if (left.addedAt === undefined) {
      return 1;
    }

    if (right.addedAt === undefined) {
      return -1;
    }

    return left.addedAt - right.addedAt;
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

// Returns the files that use an ID already used by an older file.
const newerClashingFiles = async (
  functions: SyncClashFunctions,
  root: string,
  project: ProjectName,
  files: ProjectFile[],
): Promise<ProjectFile[]> => {
  const groups = new Map<string, ProjectFile[]>();

  for (const file of files) {
    groups.set(file.id, [...(groups.get(file.id) ?? []), file]);
  }

  const clashes = [...groups.values()].filter((group) => group.length > 1);

  const dated = await Promise.all(
    clashes.map((group) => datedGroup(functions, root, project, group)),
  );

  return dated.flatMap((group) =>
    group
      .toSorted(byAge)
      .slice(1)
      .map((entry) => entry.file),
  );
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

const renameFile = async (
  functions: SyncClashFunctions,
  root: string,
  project: ProjectName,
  file: ProjectFile,
  to: TicketId,
): Promise<Result<{ alias: SyncAlias; factPath: string }, SyncReason>> => {
  const at = new Date(functions.now()).toISOString();
  const appended = await functions.appendAlias({ ticket: to, from: file.id, at });

  if (!appended.ok) {
    return failed(appended.reason.message);
  }

  const path = join('tickets', project, `${to}-${file.slug}.md`);
  const from = join('tickets', project, file.fileName);
  const moved = await functions.runGit(['-C', root, 'mv', '--', from, path]);

  // `git mv` refuses a file that is not yet tracked, so that file moves on disk.
  if (!moved.ok) {
    try {
      await functions.rename(join(root, from), join(root, path));
    } catch {
      return failed(moved.reason.message);
    }
  }

  return { ok: true, value: { alias: { from: file.id, to, path }, factPath: appended.value.path } };
};

const commitAliases = async (
  functions: SyncClashFunctions,
  root: string,
  factPaths: string[],
): Promise<Result<undefined, SyncReason>> => {
  const added = await functions.runGit(['-C', root, 'add', '--', ...factPaths]);

  if (!added.ok) {
    return failed(added.reason.message);
  }

  const options = await commitArguments(functions.runGit, root);

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

const renameClashes = async (
  functions: SyncClashFunctions,
  root: string,
  project: ProjectName,
): Promise<Result<ProjectRenames, SyncReason>> => {
  const files = await listProjectFiles(functions, root, project);
  const taken = new Set<string>(files.map((file) => file.id));
  const clashing = await newerClashingFiles(functions, root, project, files);
  const renames: ProjectRenames = { aliases: [], factPaths: [] };

  for (const file of clashing) {
    const to = freeId(functions, project, taken);

    if (to === undefined) {
      return failed(`No free ticket ID found for project "${project}".`);
    }

    taken.add(to);

    // Renames run one at a time, since each new ID must differ from the ones chosen before it.
    // oxlint-disable-next-line eslint/no-await-in-loop -- See above.
    const renamed = await renameFile(functions, root, project, file, to);

    if (!renamed.ok) {
      return renamed;
    }

    renames.aliases.push(renamed.value.alias);
    renames.factPaths.push(renamed.value.factPath);
  }

  return { ok: true, value: renames };
};

// The caller holds the store lock and has just merged. A new ID is free in the whole project
// folder, so one folder never holds two files with one ID afterwards.
export const resolveIdClashes = async (
  functions: SyncClashFunctions,
  root: string,
): Promise<Result<SyncAlias[], SyncReason>> => {
  const names = await listNames(functions, join(root, 'tickets'));
  const projects = names.map((name) => parseProjectName(name)).filter((parsed) => parsed.ok);
  const aliases: SyncAlias[] = [];
  const factPaths = new Set<string>();

  for (const project of projects) {
    // Projects run one at a time, so a failed rename stops the rest.
    // oxlint-disable-next-line eslint/no-await-in-loop -- See above.
    const renames = await renameClashes(functions, root, project.value);

    if (!renames.ok) {
      return renames;
    }

    aliases.push(...renames.value.aliases);

    for (const factPath of renames.value.factPaths) {
      factPaths.add(factPath);
    }
  }

  if (aliases.length === 0) {
    return { ok: true, value: aliases };
  }

  const committed = await commitAliases(functions, root, [...factPaths]);

  return committed.ok ? { ok: true, value: aliases } : committed;
};
