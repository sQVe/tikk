import { afterEach, beforeEach, expect, it } from 'bun:test';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { createCliFixture } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';

let fixture: CliFixture | undefined;

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const createSlice = async (): Promise<string> => {
  const file = join(cli().home, 'criteria.yaml');

  await Bun.write(file, '- id: a\n  check: check a\n  expected: a holds\n');

  const created = await cli().runJson<{ id: string }>([
    'new',
    'slice',
    'Slice',
    '--criteria-file',
    file,
  ]);

  return created.id;
};

const addRun = async (id: string, verdict = 'pass'): Promise<string> => {
  const runFile = join(cli().home, `run-${verdict}.yaml`);

  await Bun.write(
    runFile,
    `scenarios:\n  - name: Open the page\n    criteria: [a]\n    observed: It loads\n    verdict: ${verdict}\n`,
  );

  const added = await cli().runJson<{ qa: { run: string; current: boolean } }>([
    'qa',
    'add',
    id,
    '--repository',
    'acme/app',
    '--head',
    'head1',
    '--base',
    'main',
    '--change-hash',
    'hash1',
    '--run-file',
    runFile,
  ]);

  return added.qa.run;
};

const audit = async (id: string, run: string) => {
  const verdictsFile = join(cli().home, `verdicts-${run}.yaml`);
  const citation = JSON.stringify(run);

  await Bun.write(
    verdictsFile,
    `- criterion: a\n  verdict: met\n  evidence: Seen in QA\n  qa: [${citation}]\n`,
  );

  return cli().run([
    'audit',
    id,
    '--repository',
    'acme/app',
    '--head',
    'head1',
    '--base',
    'main',
    '--change-hash',
    'hash1',
    '--verdicts-file',
    verdictsFile,
  ]);
};

beforeEach(async () => {
  fixture = await createCliFixture('tikk-qa-');
  await cli().runChecked(['init']);
});

afterEach(async () => {
  await fixture?.cleanup();
});

it('records an audit that cites a QA run for its criterion', async () => {
  const id = await createSlice();
  const run = await addRun(id);
  const result = await audit(id, run);

  expect(result.exitCode).toBe(0);
});

it('records an audit that cites a stored numeric-only QA run ID', async () => {
  const id = await createSlice();
  const run = '123456789012';

  const fact = {
    version: 1,
    kind: 'qa',
    ticket: id,
    at: '2026-10-22T12:00:00.000Z',
    machine: 'numeric-run',
    target: { repository: 'acme/app', head: 'head1', base: 'main', changeHash: 'hash1' },
    run,
    scenarios: [{ name: 'Open the page', criteria: ['a'], observed: 'It loads', verdict: 'pass' }],
    artifacts: [],
    gaps: [],
  };

  const serialized = JSON.stringify(fact);

  await Bun.write(
    join(cli().storePath, 'facts', 'numeric-run', '2026-10.jsonl'),
    `${serialized}\n`,
  );

  const listed = await cli().runJson<{ runs: { run: string }[] }>([
    'qa',
    'ls',
    id,
    '--head',
    'head1',
    '--change-hash',
    'hash1',
  ]);

  expect(listed.runs.map((entry) => entry.run)).toEqual([run]);

  const result = await audit(id, run);

  expect(result.exitCode).toBe(0);
});

it('gives distinct runs distinct IDs and resolves each citation to its own run', async () => {
  const id = await createSlice();
  const passed = await addRun(id, 'pass');
  const failed = await addRun(id, 'fail');

  expect(passed).not.toBe(failed);

  const citesFailed = await audit(id, failed);

  expect(citesFailed.exitCode).not.toBe(0);
  expect(JSON.parse(citesFailed.stdout)).toMatchObject({ error: { code: 'invalidArguments' } });

  const citesPassed = await audit(id, passed);

  expect(citesPassed.exitCode).toBe(0);
});

it('refuses an audit that cites a made-up run', async () => {
  const id = await createSlice();

  await addRun(id);

  const result = await audit(id, 'ffffffffffff');

  expect(result.exitCode).not.toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: 'invalidArguments' } });
});
