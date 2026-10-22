import { createHash } from 'node:crypto';

import { redactSecrets } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { logFilePath, logsDirectory } from './storePaths.ts';
import type { Store } from './storePaths.ts';
import type { TicketFileFunctions } from './ticketFiles.ts';

export type LogFileFunctions = Pick<TicketFileFunctions, 'mkdir' | 'writeFileExclusive'>;

export interface LogStoreReason {
  message: string;
}

const errorCode = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? error.code : undefined;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// The exclusive write leaves no partial file, so sync may commit `logs/` at any time.
export const storeLog = async (
  functions: LogFileFunctions,
  store: Store,
  text: string,
): Promise<Result<{ hash: string }, LogStoreReason>> => {
  const redacted = redactSecrets(text);
  const hash = createHash('sha256').update(redacted).digest('hex');

  try {
    await functions.mkdir(logsDirectory(store));
    await functions.writeFileExclusive(logFilePath(store, hash), redacted);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {
      return { ok: false, reason: { message: `Cannot store the log: ${errorMessage(error)}` } };
    }
  }

  return { ok: true, value: { hash } };
};
