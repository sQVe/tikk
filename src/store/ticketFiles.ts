import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import { customAlphabet } from 'nanoid';

import { invariant } from '../invariant.ts';
import type { Result } from '../result.ts';
import { createTicketSlug, parseTicketId } from '../ticket/ticket.ts';
import type { ProjectName, TicketId } from '../ticket/ticket.ts';
import { projectDirectory, ticketFilePath, ticketsDirectory } from './storePaths.ts';
import type { Store } from './storePaths.ts';

export interface TicketFileEntry {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface TicketFileContent {
  text: string;
  hash: string;
}

export interface TicketFileReason {
  kind: 'notFound' | 'changedOnDisk' | 'failed';
  message: string;
}

export interface CreatedTicketFile {
  id: TicketId;
  path: string;
  hash: string;
}

export interface TicketFileFunctions {
  readdir: (directory: string) => Promise<string[]>;
  stat: (path: string) => Promise<{
    mtimeMs: number;
    size: number;
    isFile: () => boolean;
    isDirectory: () => boolean;
  }>;
  readFile: (path: string) => Promise<Uint8Array>;
  mkdir: (directory: string) => Promise<void>;
  // Must leave no file behind when it fails after creating one, and never remove a file it did not create.
  writeFileExclusive: (path: string, text: string) => Promise<void>;
  writeFile: (path: string, text: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  randomIdSuffix: () => string;
}

interface NewTicket {
  store: Store;
  project: ProjectName;
  slug: string;
  text: string;
}

type DirectoryFunctions = Pick<TicketFileFunctions, 'readdir' | 'stat'>;

type ExclusiveWrite = 'created' | 'exists' | 'failed';

type EntryStats = Awaited<ReturnType<DirectoryFunctions['stat']>>;

const idAlphabet = '346789abcdefghijkmnpqrtwxyz';
const idLength = 4;
const maxCreateAttempts = 100;

export const newIdSuffix = customAlphabet(idAlphabet, idLength);

const hashText = (text: string | Uint8Array): string =>
  createHash('sha256').update(text).digest('hex');

const errorCode = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? error.code : undefined;

const failed = (message: string): { ok: false; reason: TicketFileReason } => ({
  ok: false,
  reason: { kind: 'failed', message },
});

const listDirectory = async (
  files: DirectoryFunctions,
  directory: string,
): Promise<Result<string[], TicketFileReason>> => {
  try {
    return { ok: true, value: await files.readdir(directory) };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { ok: true, value: [] };
    }

    return failed(`Cannot list ${directory}.`);
  }
};

// A vanished entry gives undefined, so a list never fails on a file deleted mid-scan.
const statEntry = async (
  files: DirectoryFunctions,
  path: string,
): Promise<Result<EntryStats | undefined, TicketFileReason>> => {
  try {
    return { ok: true, value: await files.stat(path) };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { ok: true, value: undefined };
    }

    return failed(`Cannot check ${path}.`);
  }
};

const firstFailure = <Value>(
  results: Result<Value, TicketFileReason>[],
): Result<Value[], TicketFileReason> => {
  const values: Value[] = [];

  for (const result of results) {
    if (!result.ok) {
      return result;
    }

    values.push(result.value);
  }

  return { ok: true, value: values };
};

const listProjectFiles = async (
  files: DirectoryFunctions,
  directory: string,
  extension: string,
): Promise<Result<TicketFileEntry[], TicketFileReason>> => {
  const names = await listDirectory(files, directory);

  if (!names.ok) {
    return names;
  }

  const markdownNames = names.value.filter((name) => name.endsWith(extension));

  const checked = await Promise.all(
    markdownNames.map(
      async (name): Promise<Result<TicketFileEntry | undefined, TicketFileReason>> => {
        const path = join(directory, name);
        const stats = await statEntry(files, path);

        if (!stats.ok) {
          return stats;
        }

        if (stats.value?.isFile() !== true) {
          return { ok: true, value: undefined };
        }

        return { ok: true, value: { path, mtimeMs: stats.value.mtimeMs, size: stats.value.size } };
      },
    ),
  );

  const entries = firstFailure(checked);

  if (!entries.ok) {
    return entries;
  }

  return { ok: true, value: entries.value.filter((entry) => entry !== undefined) };
};

// Lists the files with `extension` in each folder directly under `root`.
export const listFolderFiles = async (
  files: DirectoryFunctions,
  root: string,
  extension: string,
): Promise<Result<TicketFileEntry[], TicketFileReason>> => {
  const projects = await listDirectory(files, root);

  if (!projects.ok) {
    return projects;
  }

  const checked = await Promise.all(
    projects.value.map(async (project): Promise<Result<string | undefined, TicketFileReason>> => {
      const path = join(root, project);
      const stats = await statEntry(files, path);

      if (!stats.ok) {
        return stats;
      }

      return { ok: true, value: stats.value?.isDirectory() === true ? path : undefined };
    }),
  );

  const folders = firstFailure(checked);

  if (!folders.ok) {
    return folders;
  }

  const projectFolders = folders.value.filter((path) => path !== undefined);

  const lists = firstFailure(
    await Promise.all(projectFolders.map((path) => listProjectFiles(files, path, extension))),
  );

  if (!lists.ok) {
    return lists;
  }

  return { ok: true, value: lists.value.flat() };
};

export const listTicketFiles = (
  files: TicketFileFunctions,
  store: Store,
): Promise<Result<TicketFileEntry[], TicketFileReason>> =>
  listFolderFiles(files, ticketsDirectory(store), '.md');

export const readTicketFile = async (
  files: TicketFileFunctions,
  path: string,
): Promise<Result<TicketFileContent, TicketFileReason>> => {
  let bytes: Uint8Array;

  try {
    bytes = await files.readFile(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { ok: false, reason: { kind: 'notFound', message: `${path} does not exist.` } };
    }

    return failed(`Cannot read ${path}.`);
  }

  return { ok: true, value: { text: new TextDecoder().decode(bytes), hash: hashText(bytes) } };
};

const idIsTaken = (names: string[], id: string): boolean =>
  names.some((name) => name.startsWith(`${id}-`));

const writeExclusive = async (
  files: TicketFileFunctions,
  path: string,
  text: string,
): Promise<ExclusiveWrite> => {
  try {
    await files.writeFileExclusive(path, text);

    return 'created';
  } catch (error) {
    return errorCode(error) === 'EEXIST' ? 'exists' : 'failed';
  }
};

const createWithFreeId = async (
  files: TicketFileFunctions,
  ticket: NewTicket,
  attemptsLeft: number,
): Promise<Result<CreatedTicketFile, TicketFileReason>> => {
  const { store, project, slug, text } = ticket;

  if (attemptsLeft === 0) {
    return failed(`No free ticket ID found for project "${project}".`);
  }

  const candidate = `${project}-${files.randomIdSuffix()}`;
  const parsed = parseTicketId(candidate);

  invariant(parsed.ok, `generated ID "${candidate}" must be valid`);

  const names = await listDirectory(files, projectDirectory(store, project));

  if (!names.ok) {
    return names;
  }

  if (idIsTaken(names.value, parsed.value)) {
    return createWithFreeId(files, ticket, attemptsLeft - 1);
  }

  const path = ticketFilePath(store, project, parsed.value, slug);
  const written = await writeExclusive(files, path, text);

  if (written === 'exists') {
    return createWithFreeId(files, ticket, attemptsLeft - 1);
  }

  if (written === 'failed') {
    return failed(`Cannot write ${path}.`);
  }

  return { ok: true, value: { id: parsed.value, path, hash: hashText(text) } };
};

export const createTicketFile = async (
  files: TicketFileFunctions,
  store: Store,
  project: ProjectName,
  title: string,
  text: string,
): Promise<Result<CreatedTicketFile, TicketFileReason>> => {
  const directory = projectDirectory(store, project);

  try {
    await files.mkdir(directory);
  } catch {
    return failed(`Cannot create ${directory}.`);
  }

  const ticket = { store, project, slug: createTicketSlug(title), text };

  return createWithFreeId(files, ticket, maxCreateAttempts);
};

export const writeTicketFile = async (
  files: TicketFileFunctions,
  path: string,
  expectedHash: string,
  text: string,
): Promise<Result<{ hash: string }, TicketFileReason>> => {
  const current = await readTicketFile(files, path);

  if (!current.ok) {
    return current;
  }

  if (current.value.hash !== expectedHash) {
    return {
      ok: false,
      reason: { kind: 'changedOnDisk', message: `${path} changed since it was read.` },
    };
  }

  const temporaryPath = join(dirname(path), `.${basename(path)}.${files.randomIdSuffix()}.tmp`);

  try {
    await files.writeFile(temporaryPath, text);
    await files.rename(temporaryPath, path);
  } catch {
    await files.unlink(temporaryPath).catch(() => undefined);

    return failed(`Cannot write ${path}.`);
  }

  return { ok: true, value: { hash: hashText(text) } };
};
