import { factDetailOf, factKindOf } from '../cli/cli.ts';
import type { Fact } from '../cli/cli.ts';

const lineBreak = /\r\n|[\r\n\u2028\u2029]/;

const entryOf = (fact: Fact): string[] => {
  const header = `${fact.at}  ${factKindOf(fact)}`;
  const detail = factDetailOf(fact);

  return detail === '' ? [header] : [header, ...detail.split(lineBreak).map((line) => `  ${line}`)];
};

// The facts arrive newest first from the same query as `tikk history`.
export const activityLinesOf = (facts: readonly Fact[]): string[] => facts.flatMap(entryOf);
