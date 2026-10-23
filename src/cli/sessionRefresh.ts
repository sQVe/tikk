import type { Result } from '../result.ts';
import { sweepArchive } from './archiveSweep.ts';
import type { CliEffects, CliFailure, CliSession } from './cliEffects.ts';

export const refreshSession = async (
  effects: CliEffects,
  session: CliSession,
): Promise<Result<undefined, CliFailure>> => {
  const refreshed = await session.refresh();

  if (!refreshed.ok) {
    return { ok: false, reason: { code: 'storeError', message: refreshed.reason.message } };
  }

  await sweepArchive(effects, session);

  return { ok: true, value: undefined };
};
