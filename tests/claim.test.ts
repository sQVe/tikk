import { afterEach, beforeEach, expect, it } from 'bun:test';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { createCliFixture, createParentSlice } from './cliFixture.ts';
import type { CliFixture, CliRun } from './cliFixture.ts';

interface ShownInstruction {
  id: string;
  path: string;
  hash: string;
  state: string;
  claim: { holder: string; leaseEnd: string } | null;
}

interface ReadyListing {
  candidates: { id: string; state: string }[];
  skipped: {
    id: string;
    title: string;
    reason: string;
    blockers?: { id: string; state: string }[];
  }[];
}

let fixture: CliFixture | undefined;
let parentSlice = '';

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const run = (args: string[]): Promise<CliRun> => cli().run(args);

const runJson = <Shape>(args: string[]): Promise<Shape> => cli().runJson<Shape>(args);

const errorCodeOf = (result: CliRun): unknown => {
  const parsed: unknown = JSON.parse(result.stdout);

  return (parsed as { error: { code: string } }).error.code;
};

const createInstruction = (title: string): Promise<ShownInstruction> =>
  runJson<ShownInstruction>(['new', 'instruction', title, '--parent', parentSlice]);

const stateOf = async (id: string): Promise<string> => {
  const shown = await runJson<ShownInstruction>(['show', id]);

  return shown.state;
};

beforeEach(async () => {
  fixture = await createCliFixture('tikk-claim-');
  await fixture.runChecked(['init']);
  parentSlice = await createParentSlice(fixture);
});

afterEach(async () => {
  await fixture?.cleanup();
});

it('lets exactly one of two concurrent claims on an instruction succeed', async () => {
  const instruction = await createInstruction('Contested instruction');

  const results = await Promise.all([
    run(['claim', instruction.id, '--holder', 'first']),
    run(['claim', instruction.id, '--holder', 'second']),
  ]);

  const exitCodes = results
    .map((result) => result.exitCode)
    .toSorted((left, right) => left - right);

  const loser = results.find((result) => result.exitCode !== 0);

  expect(exitCodes).toEqual([0, 1]);
  expect(loser === undefined ? undefined : errorCodeOf(loser)).toBe('conflict');
});

it('lets another holder claim an instruction after its lease ends', async () => {
  const instruction = await createInstruction('Short lease');

  // A claim whose lease ended long ago, written as another machine would write it.
  const expired = {
    version: 1,
    kind: 'claim',
    ticket: instruction.id,
    at: '2020-01-01T00:00:00.000Z',
    machine: 'other',
    holder: 'first',
    leaseEnd: '2020-01-01T01:00:00.000Z',
  };

  const factFile = join(cli().storePath, 'facts', 'other', '2020-01.jsonl');

  await Bun.write(factFile, `${JSON.stringify(expired)}\n`);

  const claimed = await runJson<ShownInstruction>(['claim', instruction.id, '--holder', 'second']);

  expect(claimed.state).toBe('active');
  expect(claimed.claim?.holder).toBe('second');

  const blocked = await run(['claim', instruction.id, '--holder', 'third']);

  expect(errorCodeOf(blocked)).toBe('conflict');
});

it('skips an instruction blocked by an open instruction and names the blocker', async () => {
  const blocker = await createInstruction('Blocker');
  const blocked = await createInstruction('Blocked');
  const blockerText = await Bun.file(blocker.path).text();
  const blockedText = await Bun.file(blocked.path).text();
  const blockedFrontMatter = `rank: 1\nblockedBy:\n  - ${blocker.id}`;
  // Bun versions differ in how they write an empty list, as `[]` on the same line or the next.
  const emptyBlockedBy = /blockedBy:\s*\[\]/;

  // The ranks put the blocked instruction first, so the ready rule reports it as skipped.
  await Bun.write(blocker.path, blockerText.replace(emptyBlockedBy, 'rank: 2\nblockedBy: []'));
  await Bun.write(blocked.path, blockedText.replace(emptyBlockedBy, blockedFrontMatter));

  const ready = await runJson<ReadyListing>(['ready']);

  expect(ready.candidates.map((candidate) => candidate.id)).toEqual([blocker.id]);

  expect(ready.skipped).toEqual([
    {
      id: blocked.id,
      title: 'Blocked',
      reason: 'blocked',
      blockers: [{ id: blocker.id, state: 'open' }],
    },
  ]);
});

it('refuses a release by another holder', async () => {
  const instruction = await createInstruction('Held instruction');

  await runJson(['claim', instruction.id, '--holder', 'first']);
  const released = await run(['release', instruction.id, '--holder', 'second']);

  expect(released.exitCode).toBe(1);
  expect(errorCodeOf(released)).toBe('conflict');
  expect(await stateOf(instruction.id)).toBe('active');
});

it('reports a submitted and accepted instruction as done', async () => {
  const instruction = await createInstruction('Finished instruction');

  await runJson(['claim', instruction.id, '--holder', 'first']);
  await runJson(['submit', instruction.id, '--holder', 'first', '--text', 'All done']);
  const submitted = await stateOf(instruction.id);

  await runJson(['accept', instruction.id]);

  expect(submitted).toBe('submitted');
  expect(await stateOf(instruction.id)).toBe('done');
});

it('reports a canceled instruction as canceled', async () => {
  const instruction = await createInstruction('Dropped instruction');

  await runJson(['cancel', instruction.id]);

  expect(await stateOf(instruction.id)).toBe('canceled');
});

it('logs to an instruction in any state', async () => {
  const open = await createInstruction('Open instruction');
  const active = await createInstruction('Active instruction');
  const done = await createInstruction('Done instruction');
  const canceled = await createInstruction('Canceled instruction');

  await runJson(['claim', active.id, '--holder', 'first']);
  await runJson(['claim', done.id, '--holder', 'first']);
  await runJson(['submit', done.id, '--holder', 'first']);
  await runJson(['accept', done.id]);
  await runJson(['cancel', canceled.id]);

  const logged = await Promise.all(
    [open, active, done, canceled].map((instruction) =>
      run(['log', instruction.id, '--type', 'progress', '--text', 'A note']),
    ),
  );

  expect(logged.map((result) => result.exitCode)).toEqual([0, 0, 0, 0]);
  expect(await stateOf(done.id)).toBe('done');
});

const readFactFiles = async (): Promise<Record<string, string>> => {
  const root = join(cli().storePath, 'facts');
  const files: Record<string, string> = {};

  for await (const path of new Bun.Glob('**/*.jsonl').scan({ cwd: root, onlyFiles: true })) {
    files[path] = await Bun.file(join(root, path)).text();
  }

  return files;
};

it('refuses claim and submit on an instruction whose file has a parse error, but still logs', async () => {
  const instruction = await createInstruction('Broken instruction');

  await runJson(['log', instruction.id, '--type', 'progress', '--text', 'Before the break']);
  await Bun.write(instruction.path, '---\nkind: [instruction\n---\nBroken\n');

  const before = await readFactFiles();
  const claimed = await run(['claim', instruction.id, '--holder', 'first']);
  const submitted = await run(['submit', instruction.id, '--holder', 'first']);
  const after = await readFactFiles();
  const logged = await run(['log', instruction.id, '--type', 'progress', '--text', 'A note']);

  expect([claimed.exitCode, submitted.exitCode]).toEqual([1, 1]);
  expect([errorCodeOf(claimed), errorCodeOf(submitted)]).toEqual(['parseError', 'parseError']);
  expect(after).toEqual(before);
  expect(logged.exitCode).toBe(0);
});

it('refuses an empty log holder and an oversized lease without writing a fact', async () => {
  const instruction = await createInstruction('Guarded instruction');

  await runJson(['log', instruction.id, '--type', 'progress', '--text', 'First note']);

  const before = await readFactFiles();

  const logged = await run([
    'log',
    instruction.id,
    '--type',
    'progress',
    '--text',
    'A',
    '--holder',
    '',
  ]);

  const claimed = await run([
    'claim',
    instruction.id,
    '--holder',
    'first',
    '--lease',
    '999999999999999999h',
  ]);

  const after = await readFactFiles();

  expect([logged.exitCode, claimed.exitCode]).toEqual([1, 1]);

  expect([errorCodeOf(logged), errorCodeOf(claimed)]).toEqual([
    'invalidArguments',
    'invalidArguments',
  ]);

  expect(after).toEqual(before);
});

it('saves the session log path of a claim and shows it', async () => {
  const instruction = await createInstruction('Logged session');

  await runJson([
    'claim',
    instruction.id,
    '--holder',
    'first',
    '--session-log',
    '/tmp/session.log',
  ]);

  const shown = await runJson<ShownInstruction & { claim: { sessionLog: string | null } }>([
    'show',
    instruction.id,
  ]);

  expect(shown.claim.sessionLog).toBe('/tmp/session.log');
});

it('keeps a claim that follows an unfinished fact line, and reports the broken line', async () => {
  const instruction = await createInstruction('Interrupted write');

  await runJson(['log', instruction.id, '--type', 'progress', '--text', 'First note']);

  const [factFile] = Object.keys(await readFactFiles());
  const factPath = join(cli().storePath, 'facts', factFile ?? '');

  await appendFile(factPath, '{"version":1,"kind":"cla');
  await runJson(['claim', instruction.id, '--holder', 'first']);

  const shown = await runJson<ShownInstruction>(['show', instruction.id]);
  const listing = await runJson<{ errors: { path: string }[] }>(['ls']);

  expect(shown.state).toBe('active');
  expect(listing.errors.map((error) => error.path)).toEqual([`${factPath}:2`]);
});

it('clears a lock left by a process that has exited', async () => {
  const instruction = await createInstruction('Abandoned lock');
  const child = Bun.spawn(['bun', '-e', '0'], { stdout: 'ignore', stderr: 'ignore' });

  await child.exited;
  await Bun.write(join(cli().storePath, '.git', 'tikk.lock'), `${child.pid}\n`);

  const claimed = await run(['claim', instruction.id, '--holder', 'first']);

  expect(claimed.exitCode).toBe(0);
  expect(await Bun.file(join(cli().storePath, '.git', 'tikk.lock')).exists()).toBe(false);
});
