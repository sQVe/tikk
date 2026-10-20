import { dirname } from 'node:path';

import { serializeFactLine } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { factFilePath, factsDirectory } from './storePaths.ts';
import type { Store } from './storePaths.ts';
import { listFolderFiles } from './ticketFiles.ts';
import type { TicketFileEntry, TicketFileFunctions, TicketFileReason } from './ticketFiles.ts';

export type FactFileEntry = TicketFileEntry;

export type FactFileReason = TicketFileReason;

export interface FactFileFunctions extends Pick<TicketFileFunctions, 'readdir' | 'stat' | 'mkdir'> {
  readFileFrom: (path: string, fromByte: number) => Promise<Uint8Array>;
  appendFile: (path: string, text: string) => Promise<void>;
}

const monthLength = 'yyyy-mm'.length;

const errorCode = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? error.code : undefined;

export const appendFact = async (
  functions: FactFileFunctions,
  store: Store,
  machine: string,
  fact: Fact,
): Promise<Result<{ path: string }, FactFileReason>> => {
  const month = fact.at.slice(0, monthLength);
  const path = factFilePath(store, machine, month);

  try {
    await functions.mkdir(dirname(path));
    await functions.appendFile(path, serializeFactLine(fact));
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
