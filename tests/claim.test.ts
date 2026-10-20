import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface RunResult {
  exitCode: number;
  stdout: string;
}

interface ShownTask {
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

const entryPath = join(import.meta.dir, '..', 'src', 'index.ts');

let home = '';
let work = '';

const run = async (args: string[]): Promise<RunResult> => {
  const child = Bun.spawn(['bun', 'run', entryPath, ...args, '--json'], {
    cwd: work,
    env: { ...process.env, HOME: home, TIKK_HOME: join(home, 'store') },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, exitCode] = await Promise.all([child.stdout.text(), child.exited]);

  return { exitCode, stdout };
};

const runJson = async <Shape>(args: string[]): Promise<Shape> => {
  const result = await run(args);

  expect(result.exitCode).toBe(0);

  return JSON.parse(result.stdout) as Shape;
};

const errorCodeOf = (result: RunResult): unknown => {
  const parsed: unknown = JSON.parse(result.stdout);

  return (parsed as { error: { code: string } }).error.code;
};

const createTask = (title: string): Promise<ShownTask> =>
  runJson<ShownTask>(['new', 'task', title]);

const stateOf = async (id: string): Promise<string> => {
  const shown = await runJson<ShownTask>(['show', id]);

  return shown.state;
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tikk-claim-'));
  work = join(home, 'work');
  await Bun.write(join(work, '.keep'), '');
  await run(['init']);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

it('lets exactly one of two concurrent claims on a task succeed', async () => {
  const task = await createTask('Contested task');

  const results = await Promise.all([
    run(['claim', task.id, '--holder', 'first']),
    run(['claim', task.id, '--holder', 'second']),
  ]);

  const exitCodes = results
    .map((result) => result.exitCode)
    .toSorted((left, right) => left - right);

  const loser = results.find((result) => result.exitCode !== 0);

  expect(exitCodes).toEqual([0, 1]);
  expect(loser === undefined ? undefined : errorCodeOf(loser)).toBe('conflict');
});

it('lets another holder claim a task after its lease ends', async () => {
  const task = await createTask('Short lease');

  await runJson(['claim', task.id, '--holder', 'first', '--lease', '1s']);
  const blocked = await run(['claim', task.id, '--holder', 'second']);

  await Bun.sleep(1100);

  const claimed = await runJson<ShownTask>(['claim', task.id, '--holder', 'second']);

  expect(errorCodeOf(blocked)).toBe('conflict');
  expect(claimed.state).toBe('active');
  expect(claimed.claim?.holder).toBe('second');
});

it('skips a task blocked by an open task and names the blocker', async () => {
  const blocker = await createTask('Blocker');
  const blocked = await createTask('Blocked');
  const blockerText = await Bun.file(blocker.path).text();
  const blockedText = await Bun.file(blocked.path).text();
  const blockedFrontMatter = `rank: 1\nblockedBy:\n  - ${blocker.id}`;

  // The ranks put the blocked task first, so the ready rule reports it as skipped.
  await Bun.write(blocker.path, blockerText.replace('blockedBy: []', 'rank: 2\nblockedBy: []'));
  await Bun.write(blocked.path, blockedText.replace('blockedBy: []', blockedFrontMatter));

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
  const task = await createTask('Held task');

  await runJson(['claim', task.id, '--holder', 'first']);
  const released = await run(['release', task.id, '--holder', 'second']);

  expect(released.exitCode).toBe(1);
  expect(errorCodeOf(released)).toBe('conflict');
  expect(await stateOf(task.id)).toBe('active');
});

it('reports a submitted and accepted task as done', async () => {
  const task = await createTask('Finished task');

  await runJson(['claim', task.id, '--holder', 'first']);
  await runJson(['submit', task.id, '--holder', 'first', '--text', 'All done']);
  const submitted = await stateOf(task.id);

  await runJson(['accept', task.id]);

  expect(submitted).toBe('submitted');
  expect(await stateOf(task.id)).toBe('done');
});

it('reports a canceled task as canceled', async () => {
  const task = await createTask('Dropped task');

  await runJson(['cancel', task.id]);

  expect(await stateOf(task.id)).toBe('canceled');
});

it('logs to a task in any state', async () => {
  const open = await createTask('Open task');
  const active = await createTask('Active task');
  const done = await createTask('Done task');
  const canceled = await createTask('Canceled task');

  await runJson(['claim', active.id, '--holder', 'first']);
  await runJson(['claim', done.id, '--holder', 'first']);
  await runJson(['submit', done.id, '--holder', 'first']);
  await runJson(['accept', done.id]);
  await runJson(['cancel', canceled.id]);

  const logged = await Promise.all(
    [open, active, done, canceled].map((task) =>
      run(['log', task.id, '--type', 'progress', '--text', 'A note']),
    ),
  );

  expect(logged.map((result) => result.exitCode)).toEqual([0, 0, 0, 0]);
  expect(await stateOf(done.id)).toBe('done');
});
