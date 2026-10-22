import type { Fact } from './factLine.ts';

type EvidenceKind = 'check' | 'qa';

type EvidenceFact<Kind extends EvidenceKind> = Extract<Fact, { kind: Kind }>;

export type EvidenceRecord<Kind extends EvidenceKind> = EvidenceFact<Kind> & { current: boolean };

export interface CodeState {
  head: string;
  changeHash?: string;
}

const sawState = (fact: Extract<Fact, { target: unknown }>, state: CodeState): boolean => {
  if (fact.target.head !== state.head) {
    return false;
  }

  return state.changeHash === undefined || fact.target.changeHash === state.changeHash;
};

const selectEvidence = <Kind extends EvidenceKind>(
  facts: Fact[],
  kind: Kind,
  ticketId: string,
  state: CodeState,
): EvidenceRecord<Kind>[] =>
  facts
    .filter((fact): fact is EvidenceFact<Kind> => fact.kind === kind && fact.ticket === ticketId)
    .toReversed()
    .map((fact) => Object.assign({}, fact, { current: sawState(fact, state) }));

export const selectChecks = (
  facts: Fact[],
  ticketId: string,
  state: CodeState,
): EvidenceRecord<'check'>[] => selectEvidence(facts, 'check', ticketId, state);

export const selectQaRuns = (
  facts: Fact[],
  ticketId: string,
  state: CodeState,
): EvidenceRecord<'qa'>[] => selectEvidence(facts, 'qa', ticketId, state);
