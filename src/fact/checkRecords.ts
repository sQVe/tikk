import type { Fact } from './factLine.ts';

export type CheckFact = Extract<Fact, { kind: 'check' }>;

export type CheckRecord = CheckFact & { current: boolean };

// The code state a caller has now. Without a change hash, the head alone decides.
export interface CodeState {
  head: string;
  changeHash?: string;
}

const sawState = (fact: CheckFact, state: CodeState): boolean => {
  if (fact.target.head !== state.head) {
    return false;
  }

  return state.changeHash === undefined || fact.target.changeHash === state.changeHash;
};

export const selectChecks = (facts: Fact[], ticketId: string, state: CodeState): CheckRecord[] =>
  facts
    .filter((fact): fact is CheckFact => fact.kind === 'check' && fact.ticket === ticketId)
    .toReversed()
    .map((fact) => Object.assign({}, fact, { current: sawState(fact, state) }));
