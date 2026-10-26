import { afterEach, beforeEach, expect, it } from 'bun:test';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { createCliFixture, createParentSlice } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';

interface CheckListing {
  checks: { command: string; exitCode: number; current: boolean }[];
}

interface FindingListing {
  findings: { fingerprint: string; status: string; match: string }[];
}

interface NeedsListing {
  items: { id: string; reason: string; fingerprint?: string }[];
}

let fixture: CliFixture | undefined;
let parentSlice = '';

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const createInstruction = async (): Promise<string> => {
  const created = await cli().runJson<{ id: string }>([
    'new',
    'instruction',
    'Evidence instruction',
    '--parent',
    parentSlice,
  ]);

  return created.id;
};

const targetFlags = (head: string): string[] => [
  '--repository',
  'tikk',
  '--head',
  head,
  '--base',
  'main',
  '--change-hash',
  'hash1',
];

const writeFindings = async (name: string, fingerprints: string[]): Promise<string> => {
  const path = join(cli().home, name);

  const findings = fingerprints.map((fingerprint) => ({
    fingerprint,
    severity: 'high',
    location: 'src/a.ts:1',
    claim: `Claim for ${fingerprint}`,
  }));

  await Bun.write(path, JSON.stringify(findings));

  return path;
};

const addReview = (id: string, findingsFile: string) =>
  cli().runJson<FindingListing>([
    'review',
    'add',
    id,
    ...targetFlags('aaa'),
    '--capture-hash',
    'capture1',
    '--mode',
    'code',
    '--findings-file',
    findingsFile,
  ]);

const factFileCount = async (): Promise<number> => {
  const files = await Array.fromAsync(new Bun.Glob('**/*.jsonl').scan({ cwd: cli().storePath }));

  const lines = await Promise.all(
    files.map((file) => Bun.file(join(cli().storePath, file)).text()),
  );

  return lines.join('').split('\n').filter(Boolean).length;
};

beforeEach(async () => {
  fixture = await createCliFixture('tikk-evidence-');
  await cli().runChecked(['init']);
  parentSlice = await createParentSlice(cli());
});

afterEach(async () => {
  await fixture?.cleanup();
});

it('marks a check current for its head and stale for another', async () => {
  const id = await createInstruction();

  await cli().runJson([
    'check',
    'add',
    id,
    '--command',
    'bun run check',
    '--exit-code',
    '0',
    ...targetFlags('aaa'),
  ]);

  const current = await cli().runJson<CheckListing>(['check', 'ls', id, '--head', 'aaa']);
  const stale = await cli().runJson<CheckListing>(['check', 'ls', id, '--head', 'bbb']);

  expect(current.checks.map((check) => check.current)).toEqual([true]);
  expect(stale.checks.map((check) => check.current)).toEqual([false]);
});

it('marks a check stale for its head when the given change hash differs', async () => {
  const id = await createInstruction();

  await cli().runJson([
    'check',
    'add',
    id,
    '--command',
    'bun run check',
    '--exit-code',
    '0',
    ...targetFlags('aaa'),
  ]);

  const listFor = (changeHash: string) =>
    cli().runJson<CheckListing>(['check', 'ls', id, '--head', 'aaa', '--change-hash', changeHash]);

  const same = await listFor('hash1');
  const edited = await listFor('hash2');

  expect(same.checks.map((check) => check.current)).toEqual([true]);
  expect(edited.checks.map((check) => check.current)).toEqual([false]);
});

it('stores a check without the credentials of its repository URL', async () => {
  const id = await createInstruction();
  const flags = targetFlags('aaa').with(1, 'https://user:abc123secret@github.com/o/r.git');

  const added = await cli().runJson<{ check: { target: { repository: string } } }>([
    'check',
    'add',
    id,
    '--command',
    'bun run check',
    '--exit-code',
    '0',
    ...flags,
  ]);

  const files = await Array.fromAsync(new Bun.Glob('**/*.jsonl').scan({ cwd: cli().storePath }));

  const stored = await Promise.all(
    files.map((file) => Bun.file(join(cli().storePath, file)).text()),
  );

  expect(added.check.target.repository).toBe('https://[redacted]@github.com/o/r.git');
  expect(stored.join('')).not.toContain('abc123secret');
});

it('stores a redacted check log by hash', async () => {
  const id = await createInstruction();
  const logFile = join(cli().home, 'check.log');

  await Bun.write(logFile, 'all passed\n');

  const added = await cli().runJson<{ check: { log: string } }>([
    'check',
    'add',
    id,
    '--command',
    'bun run check',
    '--exit-code',
    '1',
    ...targetFlags('aaa'),
    '--log-file',
    logFile,
  ]);

  expect(added.check.log).toMatch(/^[0-9a-f]{64}$/);
});

it('lists a blocked finding in needs with its fingerprint', async () => {
  const id = await createInstruction();

  await addReview(id, await writeFindings('findings.json', ['fp-1']));

  await cli().runJson([
    'finding',
    'set',
    id,
    'fp-1',
    '--status',
    'blocked',
    '--reason',
    'Needs a decision',
    '--actor',
    'agent',
  ]);

  const needs = await cli().runJson<NeedsListing>(['needs']);
  const item = needs.items.find((entry) => entry.reason === 'blockedFinding');

  expect(item?.id).toBe(id);
  expect(item?.fingerprint).toBe('fp-1');
});

it('stores a finding reason with its token redacted', async () => {
  const id = await createInstruction();
  const token = `ghp_${'a1B2'.repeat(9)}`;

  await addReview(id, await writeFindings('findings.json', ['fp-1']));

  await cli().runJson([
    'finding',
    'set',
    id,
    'fp-1',
    '--status',
    'blocked',
    '--reason',
    `Push failed with ${token}`,
    '--actor',
    'agent',
  ]);

  const files = await Array.fromAsync(new Bun.Glob('**/*.jsonl').scan({ cwd: cli().storePath }));

  const stored = await Promise.all(
    files.map((file) => Bun.file(join(cli().storePath, file)).text()),
  );

  expect(stored.join('')).toContain('Push failed with [redacted]');
  expect(stored.join('')).not.toContain(token);
});

it('marks a finding unchanged when a later review holds its fingerprint', async () => {
  const id = await createInstruction();
  const file = await writeFindings('findings.json', ['fp-1']);
  const first = await addReview(id, file);
  const second = await addReview(id, file);

  expect(first.findings.map((finding) => finding.match)).toEqual(['new']);

  expect(second.findings.map((finding) => [finding.fingerprint, finding.match])).toEqual([
    ['fp-1', 'unchanged'],
  ]);
});

it('refuses a status for an unknown fingerprint and appends no fact', async () => {
  const id = await createInstruction();

  await addReview(id, await writeFindings('findings.json', ['fp-1']));

  const before = await factFileCount();

  const refused = await cli().run([
    'finding',
    'set',
    id,
    'missing',
    '--status',
    'fixed',
    '--reason',
    'Done',
    '--actor',
    'agent',
  ]);

  expect(refused.exitCode).not.toBe(0);
  expect((JSON.parse(refused.stdout) as { error: { code: string } }).error.code).toBe('notFound');
  expect(await factFileCount()).toBe(before);
});

it('lists findings filtered by status', async () => {
  const id = await createInstruction();

  await addReview(id, await writeFindings('findings.json', ['fp-1', 'fp-2']));

  await cli().runJson([
    'finding',
    'set',
    id,
    'fp-2',
    '--status',
    'fixed',
    '--reason',
    'Done',
    '--actor',
    'agent',
  ]);

  const fixed = await cli().runJson<FindingListing>(['finding', 'ls', id, '--status', 'fixed']);

  expect(fixed.findings.map((finding) => finding.fingerprint)).toEqual(['fp-2']);
});

it('lists reviews newest first with a finding count', async () => {
  const id = await createInstruction();

  await addReview(id, await writeFindings('one.json', ['fp-1']));
  await addReview(id, await writeFindings('two.json', ['fp-1', 'fp-2']));

  const listing = await cli().runJson<{ reviews: { findingCount: number }[] }>([
    'review',
    'ls',
    id,
  ]);

  expect(listing.reviews.map((review) => review.findingCount)).toEqual([2, 1]);
});

it('refuses a review whose findings share a fingerprint and appends no fact', async () => {
  const id = await createInstruction();
  const file = await writeFindings('duplicates.json', ['fp-1', 'fp-1']);
  const before = await factFileCount();

  const refused = await cli().run([
    'review',
    'add',
    id,
    ...targetFlags('aaa'),
    '--capture-hash',
    'capture1',
    '--mode',
    'code',
    '--findings-file',
    file,
  ]);

  expect(refused.exitCode).not.toBe(0);

  expect((JSON.parse(refused.stdout) as { error: { code: string } }).error.code).toBe(
    'invalidArguments',
  );

  expect(await factFileCount()).toBe(before);
});
