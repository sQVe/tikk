import { dirname } from 'node:path';

import { serializeFactLine, validateFact } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { factFilePath, factsDirectory } from './storePaths.ts';
import type { Store } from './storePaths.ts';
import { listFolderFiles } from './ticketFiles.ts';
import type { TicketFileEntry, TicketFileFunctions, TicketFileReason } from './ticketFiles.ts';

export type FactFileEntry = TicketFileEntry;

export type FactFileReason = TicketFileReason;

export interface FactAppendReason {
  kind: 'invalid' | 'failed';
  message: string;
}

export interface FactFileFunctions extends Pick<TicketFileFunctions, 'readdir' | 'stat' | 'mkdir'> {
  readFileFrom: (path: string, fromByte: number) => Promise<Uint8Array>;
  appendFile: (path: string, text: string) => Promise<void>;
}

const monthLength = 'yyyy-mm'.length;

const errorCode = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? error.code : undefined;

const newline = 0x0a;

const fileSize = async (
  functions: FactFileFunctions,
  path: string,
): Promise<number | undefined> => {
  try {
    const { size } = await functions.stat(path);

    return size;
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? 0 : undefined;
  }
};

// Returns `undefined` when the file cannot be checked.
const endsInsideLine = async (
  functions: FactFileFunctions,
  path: string,
): Promise<boolean | undefined> => {
  const size = await fileSize(functions, path);

  if (size === undefined) {
    return undefined;
  }

  if (size === 0) {
    return false;
  }

  const last = await functions.readFileFrom(path, size - 1);

  return last[0] !== newline;
};

export const appendFact = async (
  functions: FactFileFunctions,
  store: Store,
  machine: string,
  fact: Fact,
): Promise<Result<{ path: string }, FactAppendReason>> => {
  // A line the parser would reject must never reach the file, because lines are never edited.
  const valid = validateFact(fact);

  if (!valid.ok) {
    return { ok: false, reason: { kind: 'invalid', message: valid.reason.message } };
  }

  const month = fact.at.slice(0, monthLength);
  const path = factFilePath(store, machine, month);

  try {
    await functions.mkdir(dirname(path));

    // A failed write can leave an unfinished line. The new fact starts its own line, so the broken
    // part becomes one bad line instead of joining the fact into it.
    const unfinished = await endsInsideLine(functions, path);

    if (unfinished === undefined) {
      return { ok: false, reason: { kind: 'failed', message: `Cannot check ${path}.` } };
    }

    const separator = unfinished ? '\n' : '';

    await functions.appendFile(path, `${separator}${serializeFactLine(valid.value)}`);
  } catch {
    return { ok: false, reason: { kind: 'failed', message: `Cannot write ${path}.` } };
  }

  return { ok: true, value: { path } };
};

export const listFactFiles = async (
  functions: FactFileFunctions,
  store: Store,
): Promise<Result<FactFileEntry[], FactFileReason>> =>
  listFolderFiles(functions, factsDirectory(store), '.jsonl');

export const readFactFile = async (
  functions: FactFileFunctions,
  path: string,
  fromByte: number,
): Promise<Result<Uint8Array, FactFileReason>> => {
  try {
    return { ok: true, value: await functions.readFileFrom(path, fromByte) };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { ok: false, reason: { kind: 'notFound', message: `${path} does not exist.` } };
    }

    return { ok: false, reason: { kind: 'failed', message: `Cannot read ${path}.` } };
  }
};
