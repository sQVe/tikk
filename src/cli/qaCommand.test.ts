import { expect, it } from 'bun:test';

import { failureOf, makeEffects, makeSession, makeTicket, successOf } from './cliHarness.ts';
import { qaCommand } from './qaCommand.ts';

const slice = () => {
  const base = makeTicket('demo-3467');

  return makeTicket('demo-3467', {
    frontMatter: {
      ...base.frontMatter,
      kind: 'slice',
      criteria: [{ id: 'a', check: 'Run it', expected: 'A works' }],
    },
  });
};

const runPath = '/work/run.yaml';

const runFor = (criterion: string): string =>
  `scenarios:\n  - name: Open\n    criteria: [${criterion}]\n    observed: Seen\n    verdict: pass\n`;

const addFlags = (head: string): string[] => [
  'add',
  'demo-3467',
  '--repository',
  'acme/app',
  '--head',
  head,
  '--base',
  'main',
  '--change-hash',
  'hash1',
  '--run-file',
  runPath,
];

const run = async (
  args: string[],
  options: { ticket?: ReturnType<typeof slice>; yaml?: string },
) => {
  const fakeSession = makeSession({ tickets: [options.ticket ?? slice()] });
  const files = { [runPath]: options.yaml ?? runFor('a') };
  const { effects } = makeEffects({ session: fakeSession, files });
  const result = await qaCommand({ args, json: true, effects, session: fakeSession.session });

  return { result, fakeSession, effects };
};

it('appends a qa fact with an opaque run ID and shows it as current', async () => {
  const { result, fakeSession } = await run(addFlags('head1'), {});

  expect(successOf(result).json).toMatchObject({
    qa: { kind: 'qa', current: true, artifacts: [], gaps: [] },
  });

  expect(fakeSession.appends).toHaveLength(1);

  const fact = fakeSession.appends[0]?.fact;
  const runId = fact?.kind === 'qa' ? fact.run : '';

  expect(runId).toMatch(/^[0-9a-f]{12}$/);
});

it('refuses a ticket that is not a slice and appends nothing', async () => {
  const base = slice();
  const plan = makeTicket('demo-3467', { frontMatter: { ...base.frontMatter, kind: 'plan' } });
  const { result, fakeSession } = await run(addFlags('head1'), { ticket: plan });

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.appends).toEqual([]);
});

it('refuses a criterion the slice does not have and appends nothing', async () => {
  const { result, fakeSession } = await run(addFlags('head1'), { yaml: runFor('zzz') });
  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('zzz');
  expect(fakeSession.appends).toEqual([]);
});

it('marks a run at another head as not current in the listing', async () => {
  const { fakeSession, effects } = await run(addFlags('head1'), {});
  const session = fakeSession.session;

  await session.refresh();

  const listed = await qaCommand({
    args: ['ls', 'demo-3467', '--head', 'head2'],
    json: true,
    effects,
    session,
  });

  expect(successOf(listed).json).toMatchObject({ runs: [{ kind: 'qa', current: false }] });
});
