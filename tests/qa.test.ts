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

  await Bun.write(
    verdictsFile,
    `- criterion: a\n  verdict: met\n  evidence: Seen in QA\n  qa: [${run}]\n`,
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
