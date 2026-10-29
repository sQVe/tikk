import type { Result } from '../result.ts';
import type { TicketId } from '../ticket/ticket.ts';
import type { CliFailure, CliSession, FactAppendReason } from './cliEffects.ts';

const codeOf = (kind: FactAppendReason['kind']): CliFailure['code'] => {
  if (kind === 'invalid') {
    return 'invalidArguments';
  }

  return kind === 'shared' ? 'idShared' : 'storeError';
};

export const appendFailure = (reason: FactAppendReason): { ok: false; reason: CliFailure } => ({
  ok: false,
  reason: { code: codeOf(reason.kind), message: reason.message },
});

export const unsharedIdFailure = (
  session: CliSession,
  id: TicketId,
): Result<undefined, CliFailure> => {
  const unshared = session.checkIdUnshared(id);

  return unshared.ok ? unshared : appendFailure(unshared.reason);
};
