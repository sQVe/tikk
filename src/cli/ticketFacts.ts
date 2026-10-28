import { selectTicketHistory } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import type { TicketId } from '../ticket/ticket.ts';
import type { CliFailure, CliSession } from './cliEffects.ts';

// `tikk history` and the TUI Activity tab both read through this, so they list the same facts
// in the same order.
export const readTicketFacts = async (
  session: CliSession,
  id: TicketId,
): Promise<Result<Fact[], CliFailure>> => {
  const facts = await session.listFacts([id]);

  if (!facts.ok) {
    return { ok: false, reason: { code: 'storeError', message: facts.reason.message } };
  }

  return { ok: true, value: selectTicketHistory(facts.value, id) };
};

export const factKindOf = (fact: Fact): string =>
  'type' in fact ? `${fact.kind}/${fact.type}` : fact.kind;

export const factDetailOf = (fact: Fact): string => {
  if ('text' in fact && fact.text !== undefined) {
    return fact.text;
  }

  if ('reason' in fact) {
    return fact.reason;
  }

  return '';
};
