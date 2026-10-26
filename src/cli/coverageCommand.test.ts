import { expect, it } from 'bun:test';

import { makeEffects, makeSession, makeTicket, successOf } from './cliHarness.ts';
import { coverageCommand } from './coverageCommand.ts';

const withCriteria = (id: string, kind: 'plan' | 'slice', parent?: string) => {
  const base = makeTicket(id);

  return makeTicket(id, {
    frontMatter: {
      ...base.frontMatter,
      kind,
      ...(parent === undefined ? {} : { parent: makeTicket(parent).id }),
      criteria: [{ id: 'a', check: 'Run it', expected: 'A works' }],
    },
  });
};

it('names the missing slice for a plan gap and the missing instruction for a slice gap in text', () => {
  const fakeSession = makeSession({
    tickets: [withCriteria('demo-3467', 'plan'), withCriteria('demo-4678', 'slice', 'demo-3467')],
  });

  const { effects } = makeEffects({ session: fakeSession });

  const result = coverageCommand({
    args: ['demo-3467'],
    json: false,
    effects,
    session: fakeSession.session,
  });

  expect(successOf(result).text).toBe(
    'demo-3467  a  no slice covers it\ndemo-4678  a  no instruction covers it\n',
  );
});
