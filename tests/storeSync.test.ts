import { afterEach, beforeEach, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { createCliFixture, createCloneFixtures } from './cliFixture.ts';
import type { CliFixture, CloneFixtures } from './cliFixture.ts';

interface ShownTask {
  id: string;
  path: string;
  state: string;
  claim: { holder: string } | null;
}

interface SyncReport {
  committed: boolean;
  pending: string[];
  fetched: boolean;
  merged: boolean;
  pushed: boolean;
}

let clones: CloneFixtures | undefined;
let single: CliFixture | undefined;

const clonePair = (): CloneFixtures => {
  invariant(clones !== undefined, 'The clone fixtures should be set up.');

  return clones;
};

const singleFixture = (): CliFixture => {
  invariant(single !== undefined, 'The single fixture should be set up.');

  return single;
};

beforeEach(async () => {
  clones = await createCloneFixtures('tikk-sync-');
  single = await createCliFixture('tikk-sync-single-');
});

afterEach(async () => {
  await clones?.cleanup();
  await single?.cleanup();
});

const ageFile = async (path: string): Promise<void> => {
  const past = new Date(Date.now() - 5000);

  await utimes(path, past, past);
};

// Creates a task whose file is old enough for sync to commit it.
const createSettledTask = async (fixture: CliFixture, title: string): Promise<ShownTask> => {
  const task = await fixture.runJson<ShownTask>(['new', 'task', title]);

  await ageFile(task.path);

  return task;
};

const readAllFacts = async (fixture: CliFixture): Promise<string> => {
  const factsDirectory = join(fixture.storePath, 'facts');
  const entries = await readdir(factsDirectory, { recursive: true });
  const files = entries.filter((entry) => entry.endsWith('.jsonl'));

  const texts = await Promise.all(
    files.map((file) => readFile(join(factsDirectory, file), 'utf8')),
  );

  return texts.join('');
};

const gitOutput = async (root: string, args: string[]): Promise<string> => {
  const child = Bun.spawn(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'ignore' });
  const [stdout, exitCode] = await Promise.all([child.stdout.text(), child.exited]);

  invariant(exitCode === 0, `git ${args.join(' ')} exited with ${exitCode}.`);

  return stdout;
};

it('two clones that each add facts offline sync with no conflict, and both see all facts', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const firstTask = await createSettledTask(first, 'First task');
  const secondTask = await createSettledTask(second, 'Second task');

  await first.runChecked(['claim', firstTask.id, '--holder', 'first-agent']);
  await first.runChecked(['log', firstTask.id, '--type', 'progress', '--text', 'first progress']);
  await second.runChecked(['claim', secondTask.id, '--holder', 'second-agent']);

  await second.runChecked([
    'log',
    secondTask.id,
    '--type',
    'progress',
    '--text',
    'second progress',
  ]);

  for (const fixture of [first, second, first, second]) {
    const report = await fixture.runJson<SyncReport>(['sync']);

    expect(report.pending).toEqual([]);
  }

  for (const fixture of [first, second]) {
    const shownFirst = await fixture.runJson<ShownTask>(['show', firstTask.id]);
    const shownSecond = await fixture.runJson<ShownTask>(['show', secondTask.id]);
    const facts = await readAllFacts(fixture);

    expect(shownFirst).toMatchObject({ state: 'active', claim: { holder: 'first-agent' } });
    expect(shownSecond).toMatchObject({ state: 'active', claim: { holder: 'second-agent' } });
    expect(facts).toContain('first progress');
    expect(facts).toContain('second progress');
  }
});

it('two clones that edit one ticket offline stop the sync and name the file', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const task = await createSettledTask(first, 'Shared task');

  await first.runChecked(['sync']);
  await second.runChecked(['sync']);

  const shown = await second.runJson<ShownTask>(['show', task.id]);
  const ticketPath = relative(second.storePath, shown.path);

  for (const [fixture, body] of [
    [first, 'Edited on the first machine.'],
    [second, 'Edited on the second machine.'],
  ] as const) {
    const path = join(fixture.storePath, ticketPath);
    const text = await readFile(path, 'utf8');

    await writeFile(path, `${text}\n${body}\n`);
    await ageFile(path);
  }

  await first.runChecked(['sync']);

  const result = await second.run(['sync']);
  const parsed = JSON.parse(result.stdout) as { error: { code: string; message: string } };

  expect(result.exitCode).not.toBe(0);
  expect(parsed.error.code).toBe('conflict');
  expect(parsed.error.message).toContain(ticketPath);
  expect(existsSync(join(second.storePath, '.git', 'MERGE_HEAD'))).toBe(false);

  const again = await second.run(['sync']);
  const repeated = JSON.parse(again.stdout) as { error: { code: string; message: string } };

  expect(repeated.error.code).toBe('conflict');
  expect(repeated.error.message).toContain(ticketPath);
});

it('leaves a fresh ticket file and one that does not parse out of the commit as pending', async () => {
  const fixture = singleFixture();

  await fixture.runChecked(['init']);

  const settled = await createSettledTask(fixture, 'Settled task');
  const fresh = await fixture.runJson<ShownTask>(['new', 'task', 'Fresh task']);
  const brokenCopy = join(dirname(settled.path), 'broken.md');

  await writeFile(brokenCopy, 'no front matter here\n');
  await ageFile(brokenCopy);

  const report = await fixture.runJson<SyncReport>(['sync']);
  const tracked = await gitOutput(fixture.storePath, ['ls-files']);
  const freshPath = relative(fixture.storePath, fresh.path);
  const brokenRelative = relative(fixture.storePath, brokenCopy);
  const settledPath = relative(fixture.storePath, settled.path);

  expect(report.committed).toBe(true);
  expect(report.pending.toSorted()).toEqual([brokenRelative, freshPath].toSorted());
  expect(tracked).toContain(settledPath);
  expect(tracked).not.toContain(freshPath);
  expect(tracked).not.toContain(brokenRelative);
});

it('a claim fetches first and sees a claim made on another clone', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const task = await createSettledTask(first, 'Contested task');

  await first.runChecked(['sync']);
  await second.runChecked(['sync']);
  await first.runChecked(['claim', task.id, '--holder', 'first-agent']);
  await first.runChecked(['sync']);

  const result = await second.run(['claim', task.id, '--holder', 'second-agent']);
  const parsed = JSON.parse(result.stdout) as { error: { code: string } };

  expect(result.exitCode).not.toBe(0);
  expect(parsed.error.code).toBe('conflict');
});

it('a claim still succeeds when origin points at a missing path', async () => {
  const fixture = singleFixture();

  await fixture.runChecked(['init']);

  const task = await createSettledTask(fixture, 'Offline task');

  await gitOutput(fixture.storePath, [
    'remote',
    'add',
    'origin',
    join(fixture.home, 'missing.git'),
  ]);

  const claimed = await fixture.runJson<ShownTask>(['claim', task.id, '--holder', 'agent']);

  expect(claimed).toMatchObject({ state: 'active', claim: { holder: 'agent' } });
});

const waitForRemoteCommits = async (remotePath: string, minimum: number): Promise<number> => {
  const deadline = Date.now() + 10_000;
  let count = 0;

  while (Date.now() < deadline) {
    const child = Bun.spawn(['git', '-C', remotePath, 'rev-list', '--count', 'main'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });

    const [stdout, exitCode] = await Promise.all([child.stdout.text(), child.exited]);

    count = exitCode === 0 ? Number(stdout.trim()) : 0;

    if (count >= minimum) {
      return count;
    }

    await Bun.sleep(200);
  }

  return count;
};

it('a burst of writes on a store with a remote reaches the remote with no explicit sync', async () => {
  const { first, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);

  const baseline = await waitForRemoteCommits(remotePath, 1);
  const task = await first.runJson<ShownTask>(['new', 'task', 'Burst task']);

  for (const text of ['one', 'two', 'three']) {
    await first.runChecked(['log', task.id, '--type', 'progress', '--text', text]);
  }

  const count = await waitForRemoteCommits(remotePath, baseline + 1);

  expect(count).toBeGreaterThan(baseline);
}, 30_000);
