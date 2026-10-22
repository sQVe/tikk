import { redactSecrets } from '../fact/fact.ts';
import type { CodeState, Fact } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import type { TicketId } from '../ticket/ticket.ts';
import { invalidArguments, stringValue } from './cliArguments.ts';
import type { ParsedArguments } from './cliArguments.ts';
import type { CliFailure, CommandInput } from './cliEffects.ts';
import { readTarget, requireValue } from './taskCommand.ts';
import { findTicket } from './ticketView.ts';

export interface EvidenceTarget {
  repository: string;
  head: string;
  base: string;
  changeHash: string;
}

export interface EvidenceListing {
  ticketId: TicketId;
  facts: Fact[];
  state: CodeState;
}

export const targetOptions = {
  repository: { type: 'string' },
  head: { type: 'string' },
  base: { type: 'string' },
  'change-hash': { type: 'string' },
} as const;

export const readEvidenceTarget = (
  values: ParsedArguments['values'],
  usage: string,
): Result<EvidenceTarget, CliFailure> => {
  const repository = requireValue(values, 'repository', usage);

  if (!repository.ok) {
    return repository;
  }

  const head = requireValue(values, 'head', usage);

  if (!head.ok) {
    return head;
  }

  const base = requireValue(values, 'base', usage);

  if (!base.ok) {
    return base;
  }

  const changeHash = requireValue(values, 'change-hash', usage);

  if (!changeHash.ok) {
    return changeHash;
  }

  return {
    ok: true,
    value: {
      repository: redactSecrets(repository.value),
      head: head.value,
      base: base.value,
      changeHash: changeHash.value,
    },
  };
};

export const readEvidenceListing = async (
  input: CommandInput,
  usage: string,
): Promise<Result<EvidenceListing, CliFailure>> => {
  const target = readTarget(
    input.args,
    { head: { type: 'string' }, 'change-hash': { type: 'string' } },
    usage,
  );

  if (!target.ok) {
    return target;
  }

  const head = requireValue(target.value.values, 'head', usage);

  if (!head.ok) {
    return head;
  }

  const changeHash = stringValue(target.value.values, 'change-hash');

  if (changeHash === '') {
    return invalidArguments(`Give a value for --change-hash. ${usage}`);
  }

  const ticket = findTicket(input.session, target.value.rawId);

  if (!ticket.ok) {
    return ticket;
  }

  const facts = await input.session.listFacts([ticket.value.id]);

  if (!facts.ok) {
    return { ok: false, reason: { code: 'storeError', message: facts.reason.message } };
  }

  const state = { head: head.value, ...(changeHash === undefined ? {} : { changeHash }) };

  return { ok: true, value: { ticketId: ticket.value.id, facts: facts.value, state } };
};

export const appendEvidence = async (
  input: CommandInput,
  fact: Fact,
): Promise<Result<undefined, CliFailure>> => {
  const appended = await input.session.appendFact(fact.machine, fact);

  if (appended.ok) {
    return { ok: true, value: undefined };
  }

  const { kind, message } = appended.reason;

  if (kind === 'invalid') {
    return invalidArguments(message);
  }

  return { ok: false, reason: { code: 'storeError', message } };
};
