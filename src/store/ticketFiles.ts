import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
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

type ExclusiveWrite = 'created' | 'exists' | 'failed';

const idAlphabet = '346789abcdefghijkmnpqrtwxyz';
const idLength = 4;
const maxCreateAttempts = 100;

const newIdSuffix = customAlphabet(idAlphabet, idLength);

const hashText = (text: string | Uint8Array): string =>
  createHash('sha256').update(text).digest('hex');

const errorCode = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? error.code : undefined;

const failed = (message: string): { ok: false; reason: TicketFileReason } => ({
  ok: false,
  reason: { kind: 'failed', message },
});

const listDirectory = async (directory: string): Promise<Result<string[], TicketFileReason>> => {
  try {
    return { ok: true, value: await readdir(directory) };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { ok: true, value: [] };
    }

    return failed(`Cannot list ${directory}.`);
  }
};

const listProjectFiles = async (
  directory: string,
): Promise<Result<TicketFileEntry[], TicketFileReason>> => {
  const names = await listDirectory(directory);

  if (!names.ok) {
    return names;
  }

  const markdownNames = names.value.filter((name) => name.endsWith('.md'));

  const entries = await Promise.all(
    markdownNames.map(async (name): Promise<TicketFileEntry | undefined> => {
      const path = join(directory, name);
      const stats = await stat(path).catch(() => undefined);

      if (stats === undefined || !stats.isFile()) {
        return undefined;
      }

      return { path, mtimeMs: stats.mtimeMs, size: stats.size };
    }),
  );

  return { ok: true, value: entries.filter((entry) => entry !== undefined) };
};

export const listTicketFiles = async (
  store: Store,
): Promise<Result<TicketFileEntry[], TicketFileReason>> => {
  const ticketsRoot = ticketsDirectory(store);
  const projects = await listDirectory(ticketsRoot);

  if (!projects.ok) {
    return projects;
  }

  const lists = await Promise.all(
    projects.value.map((project) => listProjectFiles(join(ticketsRoot, project))),
  );

  const entries: TicketFileEntry[] = [];

  for (const list of lists) {
    if (!list.ok) {
      return list;
    }

    entries.push(...list.value);
  }

  return { ok: true, value: entries };
};

export const readTicketFile = async (
  path: string,
): Promise<Result<TicketFileContent, TicketFileReason>> => {
  let bytes: Buffer;

  try {
    bytes = await readFile(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { ok: false, reason: { kind: 'notFound', message: `${path} does not exist.` } };
    }

    return failed(`Cannot read ${path}.`);
  }

  return { ok: true, value: { text: bytes.toString('utf8'), hash: hashText(bytes) } };
};

const idIsTaken = (names: string[], id: string): boolean =>
  names.some((name) => name.startsWith(`${id}-`));

const writeExclusive = async (path: string, text: string): Promise<ExclusiveWrite> => {
  try {
    const handle = await open(path, 'wx');

    try {
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }

    return 'created';
  } catch (error) {
    return errorCode(error) === 'EEXIST' ? 'exists' : 'failed';
  }
};

const createWithFreeId = async (
  store: Store,
  project: ProjectName,
  slug: string,
  text: string,
  attemptsLeft: number,
): Promise<Result<CreatedTicketFile, TicketFileReason>> => {
  if (attemptsLeft === 0) {
    return failed(`No free ticket ID found for project "${project}".`);
  }

  const candidate = `${project}-${newIdSuffix()}`;
  const parsed = parseTicketId(candidate);

  invariant(parsed.ok, `generated ID "${candidate}" must be valid`);

  const names = await listDirectory(projectDirectory(store, project));

  if (!names.ok) {
    return names;
  }

  if (idIsTaken(names.value, parsed.value)) {
    return createWithFreeId(store, project, slug, text, attemptsLeft - 1);
  }

  const path = ticketFilePath(store, project, parsed.value, slug);
  const written = await writeExclusive(path, text);

  if (written === 'exists') {
    return createWithFreeId(store, project, slug, text, attemptsLeft - 1);
  }

  if (written === 'failed') {
    return failed(`Cannot write ${path}.`);
  }

  return { ok: true, value: { id: parsed.value, path, hash: hashText(text) } };
};

export const createTicketFile = async (
  store: Store,
  project: ProjectName,
  title: string,
  text: string,
): Promise<Result<CreatedTicketFile, TicketFileReason>> => {
  const directory = projectDirectory(store, project);

  try {
    await mkdir(directory, { recursive: true });
  } catch {
    return failed(`Cannot create ${directory}.`);
  }

  return createWithFreeId(store, project, createTicketSlug(title), text, maxCreateAttempts);
};

export const writeTicketFile = async (
  path: string,
  expectedHash: string,
  text: string,
): Promise<Result<{ hash: string }, TicketFileReason>> => {
  const current = await readTicketFile(path);

  if (!current.ok) {
    return current;
  }

  if (current.value.hash !== expectedHash) {
    return {
      ok: false,
      reason: { kind: 'changedOnDisk', message: `${path} changed since it was read.` },
    };
  }

  const temporaryPath = join(dirname(path), `.${basename(path)}.${newIdSuffix()}.tmp`);

  try {
    await writeFile(temporaryPath, text);
    await rename(temporaryPath, path);
  } catch {
    await unlink(temporaryPath).catch(() => undefined);

    return failed(`Cannot write ${path}.`);
  }

  return { ok: true, value: { hash: hashText(text) } };
};
