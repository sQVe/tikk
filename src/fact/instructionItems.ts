import type { Fact } from './factLine.ts';

export interface InstructionItem {
  item: string;
  at: string;
}

export interface OpenQuestion extends InstructionItem {
  text: string;
}

type SubmittedFact = Extract<Fact, { kind: 'log'; item: string }> & { type: 'submitted' };

const answeredItems = (own: Fact[]): Set<string> =>
  new Set(
    own.flatMap((fact) => (fact.kind === 'log' && fact.type === 'answer' ? [fact.item] : [])),
  );

export const selectOpenQuestions = (own: Fact[]): OpenQuestion[] => {
  const answered = answeredItems(own);

  return own.flatMap((fact) => {
    const isQuestion = fact.kind === 'log' && fact.type === 'question';

    return isQuestion && !answered.has(fact.item)
      ? [{ item: fact.item, at: fact.at, text: fact.text }]
      : [];
  });
};

const isSubmitted = (fact: Fact): fact is SubmittedFact =>
  fact.kind === 'log' && fact.type === 'submitted';

export const latestSubmission = (own: Fact[]): InstructionItem | undefined => {
  const submitted = own.findLast(isSubmitted);

  return submitted === undefined ? undefined : { item: submitted.item, at: submitted.at };
};

export const selectPassedUp = (own: Fact[]): Set<string> =>
  new Set(own.flatMap((fact) => (fact.kind === 'passUp' ? [fact.item] : [])));
