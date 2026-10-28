import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { createCliFixture } from './cliFixture.ts';
import type { CliFixture, CliRun } from './cliFixture.ts';
import { createFakeGh } from './fakeGh.ts';
import type { FakeGh, FakePullRequest } from './fakeGh.ts';

interface SliceShow {
  state: string;
  openInstructions: string[];
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

const auditFactCount = async (): Promise<number> => {
  const files = await Array.fromAsync(new Bun.Glob('**/*.jsonl').scan({ cwd: cli().storePath }));

  const texts = await Promise.all(
    files.map((file) => Bun.file(join(cli().storePath, file)).text()),
  );

  const lines = texts.join('').split('\n');

  return lines.filter((line) => line.includes('"kind":"audit"')).length;
};

const editSlice = async (id: string, change: string[]): Promise<void> => {
  const { hash } = await cli().runJson<{ hash: string }>(['show', id]);

  await cli().runJson(['edit', id, '--hash', hash, ...change]);
};

const auditWithHash = async (
  id: string,
  hash: string,
  head: string,
  repository = 'acme/app',
): Promise<CliRun> => {
  const verdicts = await writeFixtureFile(
    'verdicts.yaml',
    '- criterion: works\n  verdict: met\n  evidence: The check passed\n',
  );

  return cli().run([
    'audit',
    id,
    '--repository',
    repository,
    '--head',
    head,
    '--base',
    'main',
    '--change-hash',
    'hash1',
    '--hash',
    hash,
    '--verdicts-file',
    verdicts,
    '--json',
  ]);
};

const auditAllMet = async (
  id: string,
  head: string,
  repository = 'acme/app',
): Promise<SliceShow> => {
  const { hash } = await cli().runJson<{ hash: string }>(['show', id]);
  const result = await auditWithHash(id, hash, head, repository);

  invariant(result.exitCode === 0, `The audit should succeed: ${result.stderr}${result.stdout}`);

  return showSlice(id);
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

it('keeps the slice done after a title edit that keeps the audit', async () => {
  const id = await createSlice();

  await cli().runJson(['pr', 'link', id, prUrl]);
  await auditAllMet(id, 'head1');

  await editSlice(id, ['--title', 'Renamed slice']);

  expect((await showSlice(id)).state).toBe('done');
});

it('voids the audit when a criterion expected text changes and keeps its ID', async () => {
  const id = await createSlice();

  await cli().runJson(['pr', 'link', id, prUrl]);
  await auditAllMet(id, 'head1');

  const criteria = await writeFixtureFile(
    'reworded.yaml',
    '- id: works\n  check: Run it\n  expected: It works faster\n',
  );

  await editSlice(id, ['--criteria-file', criteria]);

  expect((await showSlice(id)).state).toBe('mergedUnverified');
});

it('refuses an audit whose hash was read before a criterion changed and appends nothing', async () => {
  const id = await createSlice();

  await cli().runJson(['pr', 'link', id, prUrl]);

  const { hash } = await cli().runJson<{ hash: string }>(['show', id]);

  const criteria = await writeFixtureFile(
    'reworded.yaml',
    '- id: works\n  check: Run it\n  expected: It works faster\n',
  );

  await editSlice(id, ['--criteria-file', criteria]);

  const audits = await auditFactCount();
  const result = await auditWithHash(id, hash, 'head1');

  expect(result.exitCode).not.toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: 'changedOnDisk' } });
  expect(await auditFactCount()).toBe(audits);
  expect((await showSlice(id)).state).toBe('mergedUnverified');
});

it('keeps the slice unverified when the audit is for another head', async () => {
  const id = await createSlice();

  await cli().runJson(['pr', 'link', id, prUrl]);
  await auditAllMet(id, 'older-head');

  expect((await showSlice(id)).state).toBe('mergedUnverified');
});

it('keeps the slice unverified when the audit is for another repository', async () => {
  const id = await createSlice();

  await cli().runJson(['pr', 'link', id, prUrl]);
  await auditAllMet(id, 'head1', 'other/repo');

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

it('sees a merge after a linked PR closed and reopened', async () => {
  await fakeGh().setPullRequest({ ...open, state: 'CLOSED' });

  const id = await createSlice();

  await cli().runJson(['pr', 'link', id, prUrl]);

  expect((await showSlice(id)).state).toBe('planned');

  await fakeGh().setPullRequest(merged);
  await cli().runJson(['ready']);

  expect((await showSlice(id)).state).toBe('mergedUnverified');
});

// A PATH with only bun and git, so tikk cannot start gh.
const pathWithoutGh = async (): Promise<string> => {
  const directory = join(cli().home, 'bin');
  const git = Bun.which('git');

  invariant(git !== null, 'The tests need git on PATH.');

  await mkdir(directory);
  await symlink(process.execPath, join(directory, 'bun'));
  await symlink(git, join(directory, 'git'));

  return directory;
};

const readFacts = async (): Promise<string[]> => {
  const root = join(cli().storePath, 'facts');
  const paths = await readdir(root, { recursive: true });
  const files = paths.filter((path) => path.endsWith('.jsonl')).toSorted();

  return Promise.all(files.map((path) => readFile(join(root, path), 'utf8')));
};

it('lists ready work with one reconcile problem and appends no fact when gh cannot start', async () => {
  await fakeGh().setPullRequest(open);

  const id = await createSlice();

  await cli().runJson(['pr', 'link', id, prUrl]);

  const before = await readFacts();
  const result = await cli().run(['ready'], { path: await pathWithoutGh() });
  const listing = JSON.parse(result.stdout) as { reconcileProblems: { ticket: string }[] };

  expect(result.exitCode).toBe(0);
  expect(listing.reconcileProblems).toHaveLength(1);
  expect(listing.reconcileProblems[0]?.ticket).toBe(id);
  expect(await readFacts()).toEqual(before);
});

it('flags a merged, audited slice that still has an open instruction', async () => {
  const id = await createSlice();

  const instruction = await cli().runJson<{ id: string }>([
    'new',
    'instruction',
    'An instruction',
    '--parent',
    id,
  ]);

  await cli().runJson(['pr', 'link', id, prUrl]);
  await auditAllMet(id, 'head1');

  const shown = await showSlice(id);

  expect(shown.state).toBe('flagged');
  expect(shown.openInstructions).toEqual([instruction.id]);
});
