import type { Fact } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { invalidArguments } from './cliArguments.ts';
import type { ParsedArguments } from './cliArguments.ts';
import type { CliFailure, CommandInput } from './cliEffects.ts';
import { requireValue } from './taskCommand.ts';

export interface EvidenceTarget {
  repository: string;
  head: string;
  base: string;
  changeHash: string;
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
      repository: repository.value,
      head: head.value,
      base: base.value,
      changeHash: changeHash.value,
    },
  };
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
