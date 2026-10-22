import { expect, it } from 'bun:test';

import {
  failureOf,
  makeEffects,
  makeFact,
  makeSession,
  makeTicket,
  successOf,
} from './cliHarness.ts';
import { sliceAudit } from './sliceAudit.ts';

const slice = (kind: 'slice' | 'task' = 'slice') => {
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
    kind?: 'slice' | 'task';
    withFile?: boolean;
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

const fullArguments = ['demo-3467', '--head', 'head1', '--base', 'main', '--verdicts-file'].concat(
  verdictsPath,
);

it('appends one audit fact and shows the slice as done', async () => {
  const { result, appends } = await audit(fullArguments);

  expect(successOf(result).json).toMatchObject({ id: 'demo-3467', state: 'done' });
  expect(appends).toHaveLength(1);

  expect(appends[0]?.fact).toMatchObject({
    kind: 'audit',
    ticket: 'demo-3467',
    head: 'head1',
    base: 'main',
    verdicts: [
      { criterion: 'first', verdict: 'met', evidence: 'Test passes' },
      { criterion: 'second', verdict: 'met', evidence: 'Test passes' },
    ],
  });
});

it.each([
  ['--head', ['demo-3467', '--base', 'main', '--verdicts-file', verdictsPath]],
  ['--base', ['demo-3467', '--head', 'head1', '--verdicts-file', verdictsPath]],
  ['--verdicts-file', ['demo-3467', '--head', 'head1', '--base', 'main']],
])('refuses a missing %s with the usage', async (_flag, args) => {
  const { result, appends } = await audit(args);
  const failure = failureOf(result);

  expect(failure.code).toBe('invalidArguments');
  expect(failure.message).toContain('Usage: tikk audit');
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
  const { result, appends } = await audit(fullArguments, { kind: 'task' });
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
