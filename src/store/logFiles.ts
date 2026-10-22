import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import { redactSecrets } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { logFilePath, logsDirectory } from './storePaths.ts';
import type { Store } from './storePaths.ts';
import type { TicketFileFunctions } from './ticketFiles.ts';

export type LogFileFunctions = Pick<
  TicketFileFunctions,
  'mkdir' | 'writeFile' | 'rename' | 'unlink' | 'randomIdSuffix'
>;

export interface LogStoreReason {
  message: string;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// The log appears under its final name only when complete, so a reader or sync never sees part of
// it. A rename over an existing log is safe, because the same name always holds the same text.
export const storeLog = async (
  functions: LogFileFunctions,
  store: Store,
  text: string,
): Promise<Result<{ hash: string }, LogStoreReason>> => {
  const redacted = redactSecrets(text);
  const hash = createHash('sha256').update(redacted).digest('hex');
  const path = logFilePath(store, hash);
  const temporaryPath = join(dirname(path), `.${basename(path)}.${functions.randomIdSuffix()}.tmp`);

  try {
    await functions.mkdir(logsDirectory(store));
    await functions.writeFile(temporaryPath, redacted);
    await functions.rename(temporaryPath, path);
  } catch (error) {
    await functions.unlink(temporaryPath).catch(() => undefined);

    return { ok: false, reason: { message: `Cannot store the log: ${errorMessage(error)}` } };
  }

  return { ok: true, value: { hash } };
};
