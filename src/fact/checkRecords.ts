import type { Fact } from './factLine.ts';

export type CheckFact = Extract<Fact, { kind: 'check' }>;

export type CheckRecord = CheckFact & { current: boolean };

export const selectChecks = (facts: Fact[], ticketId: string, head: string): CheckRecord[] =>
  facts
    .filter((fact): fact is CheckFact => fact.kind === 'check' && fact.ticket === ticketId)
    .toReversed()
    .map((fact) => Object.assign({}, fact, { current: fact.target.head === head }));
