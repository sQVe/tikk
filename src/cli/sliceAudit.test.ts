import { expect, it } from 'bun:test';

import { criterionFingerprint } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import {
  failureOf,
  makeEffects,
  makeFact,
  makeSession,
  makeTicket,
  successOf,
} from './cliHarness.ts';
import { sliceAudit } from './sliceAudit.ts';

const slice = (kind: 'slice' | 'instruction' = 'slice') => {
  const base = makeTicket('demo-3467');

  return makeTicket('demo-3467', {
    frontMatter: {
      ...base.frontMatter,
      kind,
      criteria: [
        { id: 'first', check: 'Run it', expected: 'First works' },
        { id: 'second', check: 'Run it', expected: 'Second works' },
      ],
    },
  });
};

const verdictsPath = '/work/verdicts.yaml';

const allMet = [
  '- criterion: first',
  '  verdict: met',
  '  evidence: Test passes',
  '- criterion: second',
  '  verdict: met',
  '  evidence: Test passes',
  '',
].join('\n');

const audit = async (
  args: string[],
  options: {
    text?: string;
    kind?: 'slice' | 'instruction';
    withFile?: boolean;
    facts?: Fact[];
    appendFailure?: { kind: 'invalid' | 'failed'; message: string };
  } = {},
) => {
  const { appendFailure: reason } = options;

  const appendFailure =
    reason === undefined
      ? {}
      : { appendFact: () => Promise.resolve({ ok: false as const, reason }) };

  const fakeSession = makeSession({
    tickets: [slice(options.kind)],
    facts: [
      ...(options.facts ?? []),
      makeFact({
        kind: 'pr',
        repository: 'acme/app',
        number: 7,
        state: 'merged',
        base: 'main',
        head: 'head1',
        mergeCommit: 'merge1',
        trunk: 'main',
        inTrunk: true,
      }),
    ],
    overrides: appendFailure,
  });

  const files = options.withFile === false ? {} : { [verdictsPath]: options.text ?? allMet };
  const { effects } = makeEffects({ session: fakeSession, files });
  const result = await sliceAudit({ args, json: true, effects, session: fakeSession.session });

  return { result, appends: fakeSession.appends };
};

const fullArguments = [
  'demo-3467',
  '--repository',
  'acme/app',
  '--head',
  'head1',
  '--base',
  'main',
  '--change-hash',
  'hash1',
  '--verdicts-file',
  verdictsPath,
];

it('appends one audit fact and shows the slice as done', async () => {
  const { result, appends } = await audit(fullArguments);

  expect(successOf(result).json).toMatchObject({ id: 'demo-3467', state: 'done' });
  expect(appends).toHaveLength(1);

  expect(appends[0]?.fact).toMatchObject({
    kind: 'audit',
    ticket: 'demo-3467',
    repository: 'acme/app',
    changeHash: 'hash1',
    head: 'head1',
    base: 'main',
    verdicts: [
      { criterion: 'first', verdict: 'met', evidence: 'Test passes' },
      { criterion: 'second', verdict: 'met', evidence: 'Test passes' },
    ],
  });
});

it('stores the fingerprint of each criterion text that the verdict judged', async () => {
  const { appends } = await audit(fullArguments);
  const verdicts = appends[0]?.fact.kind === 'audit' ? appends[0].fact.verdicts : [];

  expect(verdicts).toEqual([
    {
      criterion: 'first',
      verdict: 'met',
      evidence: 'Test passes',
      definition: criterionFingerprint({ check: 'Run it', expected: 'First works' }),
    },
    {
      criterion: 'second',
      verdict: 'met',
      evidence: 'Test passes',
      definition: criterionFingerprint({ check: 'Run it', expected: 'Second works' }),
    },
  ]);
});

it.each(['--repository', '--head', '--base', '--change-hash', '--verdicts-file'])(
  'refuses a missing %s with the usage',
  async (flag) => {
    const at = fullArguments.indexOf(flag);
    const args = fullArguments.filter((_value, index) => index !== at && index !== at + 1);
    const { result, appends } = await audit(args);
    const failure = failureOf(result);

    expect(failure.code).toBe('invalidArguments');
    expect(failure.message).toContain('Usage: tikk audit');
    expect(appends).toEqual([]);
  },
);

it('refuses a malformed repository and appends nothing', async () => {
  const args = fullArguments.map((value) => (value === 'acme/app' ? 'app' : value));
  const { result, appends } = await audit(args);
  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('owner/name');
  expect(appends).toEqual([]);
});

it('refuses a verdicts file that cannot be read', async () => {
  const { result, appends } = await audit(fullArguments, { withFile: false });
  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain(verdictsPath);
  expect(appends).toEqual([]);
});

it('refuses a verdicts file that is not a list', async () => {
  const { result, appends } = await audit(fullArguments, { text: 'criterion: first\n' });
  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('YAML list');
  expect(appends).toEqual([]);
});

it('refuses a verdicts file that is not valid YAML', async () => {
  const { result, appends } = await audit(fullArguments, { text: '- [unclosed\n' });
  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('is not valid YAML');
  expect(appends).toEqual([]);
});

it('reports a fact the store refuses as invalid arguments', async () => {
  const appendFailure = { kind: 'invalid' as const, message: 'Fact is wrong.' };
  const failure = failureOf((await audit(fullArguments, { appendFailure })).result);

  expect(failure).toMatchObject({ code: 'invalidArguments', message: 'Fact is wrong.' });
});

it('reports a store write failure as a store error', async () => {
  const appendFailure = { kind: 'failed' as const, message: 'Disk is full.' };
  const failure = failureOf((await audit(fullArguments, { appendFailure })).result);

  expect(failure).toMatchObject({ code: 'storeError', message: 'Disk is full.' });
});

it('refuses a verdict that the fact schema rejects', async () => {
  const text = '- criterion: first\n  verdict: fine\n  evidence: Test passes\n';
  const { result, appends } = await audit(fullArguments, { text });

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(appends).toEqual([]);
});

it('refuses a ticket that is not a slice', async () => {
  const { result, appends } = await audit(fullArguments, { kind: 'instruction' });
  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('is not a slice');
  expect(appends).toEqual([]);
});

it('refuses a criterion that the slice does not have', async () => {
  const text = `${allMet}- criterion: third\n  verdict: met\n  evidence: Test passes\n`;
  const { result, appends } = await audit(fullArguments, { text });
  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('third');
  expect(failure.message).toContain('not a criterion');
  expect(appends).toEqual([]);
});

it('refuses a criterion with two verdicts', async () => {
  const text = `${allMet}- criterion: first\n  verdict: not-met\n  evidence: Test fails\n`;
  const { result, appends } = await audit(fullArguments, { text });
  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('first');
  expect(failure.message).toContain('twice');
  expect(appends).toEqual([]);
});

it('refuses an audit that leaves a criterion without a verdict', async () => {
  const text = '- criterion: first\n  verdict: met\n  evidence: Test passes\n';
  const { result, appends } = await audit(fullArguments, { text });
  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('second');
  expect(failure.message).toContain('no verdict');
  expect(appends).toEqual([]);
});

const qaRun = (
  head: string,
  scenarioVerdict: string,
  criteria = ['first'],
  repository = 'acme/app',
): Fact =>
  makeFact({
    kind: 'qa',
    run: 'abc123abc123',
    target: { repository, head, base: 'main', changeHash: 'hash1' },
    scenarios: [{ name: 'Open', criteria, observed: 'Seen', verdict: scenarioVerdict }],
    artifacts: [],
    gaps: [],
  });

const citing = (run: string): string =>
  allMet.replace(
    '- criterion: first\n  verdict: met\n  evidence: Test passes',
    `- criterion: first\n  verdict: met\n  evidence: Test passes\n  qa: [${run}]`,
  );

it('appends an audit that cites a passing QA run', async () => {
  const { result, appends } = await audit(fullArguments, {
    text: citing('abc123abc123'),
    facts: [qaRun('head1', 'pass')],
  });

  expect(result.ok).toBe(true);
  expect(appends).toHaveLength(1);
});

it.each([
  ['unknown', 'ffffffffffff', qaRun('head1', 'pass')],
  ['at another head', 'abc123abc123', qaRun('head2', 'pass')],
  ['from another repository', 'abc123abc123', qaRun('head1', 'pass', ['first'], 'acme/other')],
  ['without a scenario for the criterion', 'abc123abc123', qaRun('head1', 'pass', ['second'])],
  ['with a failed scenario cited by a met verdict', 'abc123abc123', qaRun('head1', 'fail')],
  ['with a blocked scenario cited by a met verdict', 'abc123abc123', qaRun('head1', 'blocked')],
])('refuses a cited run that is %s and appends nothing', async (_name, run, fact) => {
  const { result, appends } = await audit(fullArguments, {
    text: citing(run),
    facts: [fact],
  });

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(appends).toEqual([]);
});

it('appends a not-met verdict that cites a failed QA run', async () => {
  const text = citing('abc123abc123').replace(
    'criterion: first\n  verdict: met',
    'criterion: first\n  verdict: not-met',
  );

  const { result, appends } = await audit(fullArguments, {
    text,
    facts: [qaRun('head1', 'fail')],
  });

  expect(result.ok).toBe(true);
  expect(appends).toHaveLength(1);
});

it('refuses a met verdict when any cited scenario for the criterion did not pass', async () => {
  const run = makeFact({
    kind: 'qa',
    run: 'abc123abc123',
    target: { repository: 'acme/app', head: 'head1', base: 'main', changeHash: 'hash1' },
    scenarios: [
      { name: 'Open', criteria: ['first'], observed: 'Seen', verdict: 'pass' },
      { name: 'Close', criteria: ['first'], observed: 'Stuck', verdict: 'fail' },
    ],
    artifacts: [],
    gaps: [],
  });

  const { result, appends } = await audit(fullArguments, {
    text: citing('abc123abc123'),
    facts: [run],
  });

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(appends).toEqual([]);
});
