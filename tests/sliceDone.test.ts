import { afterEach, beforeEach, expect, it } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { createCliFixture } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';
import { createFakeGh } from './fakeGh.ts';
import type { FakeGh, FakePullRequest } from './fakeGh.ts';

interface SliceShow {
  state: string;
  flagged: boolean;
  openTasks: string[];
}

interface NeedsListing {
  items: { id: string; reason: string }[];
}

const prUrl = 'https://github.com/acme/app/pull/7';

const open: FakePullRequest = { state: 'OPEN', base: 'main', head: 'head1', mergeCommit: null };
const merged: FakePullRequest = { ...open, state: 'MERGED', mergeCommit: 'merge1' };

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

  await writeFile(path, text);

  return path;
};

const createSlice = async (): Promise<string> => {
  const criteria = await writeFixtureFile(
    'criteria.yaml',
    '- id: works\n  check: Run it\n  expected: It works\n',
  );

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

  return slice.id;
};

const showSlice = (id: string): Promise<SliceShow> => cli().runJson<SliceShow>(['show', id]);

const auditAllMet = async (id: string, head: string): Promise<SliceShow> => {
  const verdicts = await writeFixtureFile(
    'verdicts.yaml',
    '- criterion: works\n  verdict: met\n  evidence: The check passed\n',
  );

  return cli().runJson<SliceShow>([
    'audit',
    id,
    '--head',
    head,
    '--base',
    'main',
    '--verdicts-file',
    verdicts,
  ]);
};

beforeEach(async () => {
  gh = await createFakeGh(merged);
  fixture = await createCliFixture('tikk-slice-done-', { pathPrefix: fakeGh().directory });
  await cli().runChecked(['init']);
});

afterEach(async () => {
  await fixture?.cleanup();
  await gh?.cleanup();
});

it('shows a merged slice with no audit as mergedUnverified and lists it in needs', async () => {
  const id = await createSlice();

  await cli().runJson(['pr', 'link', id, prUrl]);

  expect((await showSlice(id)).state).toBe('mergedUnverified');

  const needs = await cli().runJson<NeedsListing>(['needs']);

  const reasons = needs.items.filter((item) => item.id === id).map((item) => item.reason);

  expect(reasons).toEqual(['mergedUnverified']);
});

it('shows the slice as done after an audit that meets every criterion for the merged head', async () => {
  const id = await createSlice();

  await cli().runJson(['pr', 'link', id, prUrl]);

  const audited = await auditAllMet(id, 'head1');

  expect(audited.state).toBe('done');
  expect((await showSlice(id)).state).toBe('done');
});

it('keeps the slice unverified when the audit is for another head', async () => {
  const id = await createSlice();

  await cli().runJson(['pr', 'link', id, prUrl]);
  await auditAllMet(id, 'older-head');

  expect((await showSlice(id)).state).toBe('mergedUnverified');
});

it('shows a slice as mergedUnverified after one ready once gh reports the merge', async () => {
  await fakeGh().setPullRequest(open);

  const id = await createSlice();

  await cli().runJson(['pr', 'link', id, prUrl]);

  expect((await showSlice(id)).state).toBe('inReview');

  await fakeGh().setPullRequest(merged);
  await cli().runJson(['ready']);

  expect((await showSlice(id)).state).toBe('mergedUnverified');
});

it('flags a merged slice that still has an open task', async () => {
  const id = await createSlice();
  const task = await cli().runJson<{ id: string }>(['new', 'task', 'A task', '--parent', id]);

  await cli().runJson(['pr', 'link', id, prUrl]);

  const shown = await showSlice(id);

  expect(shown.flagged).toBe(true);
  expect(shown.openTasks).toEqual([task.id]);
});
