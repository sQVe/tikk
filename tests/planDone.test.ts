import { afterEach, beforeEach, expect, it } from 'bun:test';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { createCliFixture } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';
import { createFakeGh } from './fakeGh.ts';
import type { FakeGh, FakePullRequest } from './fakeGh.ts';

interface Shown {
  status: string;
  state: string;
  hash: string;
}

const prUrl = 'https://github.com/acme/app/pull/7';

const merged: FakePullRequest = {
  state: 'MERGED',
  base: 'main',
  head: 'head1',
  mergeCommit: 'merge1',
};

let fixture: CliFixture | undefined;
let gh: FakeGh | undefined;

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const fakeGh = (): FakeGh => {
  invariant(gh !== undefined, 'The fake gh should be set up.');

  return gh;
};

const writeFixtureFile = async (name: string, text: string): Promise<string> => {
  const path = join(cli().home, name);

  await Bun.write(path, text);

  return path;
};

const worksCriterion = '- id: works\n  check: Run it\n  expected: It works\n';
const extraCriterion = '- id: extra\n  check: Run it again\n  expected: It still works\n';

const showJson = (id: string): Promise<Shown> => cli().runJson<Shown>(['show', id]);

// A plan whose only slice is merged and audited against the criterion it has now.
const createAuditedPlan = async (): Promise<{ plan: string; slice: string }> => {
  const criteria = await writeFixtureFile('criteria.yaml', worksCriterion);

  const plan = await cli().runJson<{ id: string }>([
    'new',
    'plan',
    'A plan',
    '--criteria-file',
    criteria,
  ]);

  const slice = await cli().runJson<{ id: string }>([
    'new',
    'slice',
    'A slice',
    '--parent',
    plan.id,
    '--criteria-file',
    criteria,
  ]);

  await cli().runJson(['pr', 'link', slice.id, prUrl]);

  const verdicts = await writeFixtureFile(
    'verdicts.yaml',
    '- criterion: works\n  verdict: met\n  evidence: The check passed\n',
  );

  const { hash } = await cli().runJson<{ hash: string }>(['show', slice.id]);

  await cli().runJson([
    'audit',
    slice.id,
    '--hash',
    hash,
    '--repository',
    'acme/app',
    '--head',
    'head1',
    '--base',
    'main',
    '--change-hash',
    'hash1',
    '--verdicts-file',
    verdicts,
  ]);

  return { plan: plan.id, slice: slice.id };
};

beforeEach(async () => {
  gh = await createFakeGh(merged);
  fixture = await createCliFixture('tikk-plan-done-', { pathPrefix: fakeGh().directory });
  await cli().runChecked(['init']);
});

afterEach(async () => {
  await fixture?.cleanup();
  await gh?.cleanup();
});

it('shows a plan open once its merged, audited slice gains a criterion the audit does not cover', async () => {
  const { plan, slice } = await createAuditedPlan();

  expect((await showJson(plan)).state).toBe('done');

  const sliceShown = await showJson(slice);
  const extra = await writeFixtureFile('extra.yaml', `${worksCriterion}${extraCriterion}`);

  await cli().runChecked(['edit', slice, '--hash', sliceShown.hash, '--criteria-file', extra]);

  expect((await showJson(slice)).state).toBe('mergedUnverified');
  expect(await showJson(plan)).toMatchObject({ status: 'open', state: 'open' });
});
