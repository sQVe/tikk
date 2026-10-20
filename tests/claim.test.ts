import { afterEach, beforeEach, expect, it } from 'bun:test';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
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
  // Bun versions differ in how they write an empty list, as `[]` on the same line or the next.
  const emptyBlockedBy = /blockedBy:\s*\[\]/;

  // The ranks put the blocked task first, so the ready rule reports it as skipped.
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

const readFactFiles = async (): Promise<Record<string, string>> => {
  const root = join(home, 'store', 'facts');
  const files: Record<string, string> = {};

  for await (const path of new Bun.Glob('**/*.jsonl').scan({ cwd: root, onlyFiles: true })) {
    files[path] = await Bun.file(join(root, path)).text();
  }

  return files;
};

it('refuses claim and submit on a task whose file has a parse error, but still logs', async () => {
  const task = await createTask('Broken task');

  await runJson(['log', task.id, '--type', 'progress', '--text', 'Before the break']);
  await Bun.write(task.path, '---\nkind: [task\n---\nBroken\n');

  const before = await readFactFiles();
  const claimed = await run(['claim', task.id, '--holder', 'first']);
  const submitted = await run(['submit', task.id, '--holder', 'first']);
  const after = await readFactFiles();
  const logged = await run(['log', task.id, '--type', 'progress', '--text', 'A note']);

  expect([claimed.exitCode, submitted.exitCode]).toEqual([1, 1]);
  expect([errorCodeOf(claimed), errorCodeOf(submitted)]).toEqual(['parseError', 'parseError']);
  expect(after).toEqual(before);
  expect(logged.exitCode).toBe(0);
});

it('refuses an empty log holder and an oversized lease without writing a fact', async () => {
  const task = await createTask('Guarded task');

  await runJson(['log', task.id, '--type', 'progress', '--text', 'First note']);

  const before = await readFactFiles();
  const logged = await run(['log', task.id, '--type', 'progress', '--text', 'A', '--holder', '']);

  const claimed = await run([
    'claim',
    task.id,
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
  const task = await createTask('Logged session');

  await runJson(['claim', task.id, '--holder', 'first', '--session-log', '/tmp/session.log']);

  const shown = await runJson<ShownTask & { claim: { sessionLog: string | null } }>([
    'show',
    task.id,
  ]);

  expect(shown.claim.sessionLog).toBe('/tmp/session.log');
});

it('keeps a claim that follows an unfinished fact line, and reports the broken line', async () => {
  const task = await createTask('Interrupted write');

  await runJson(['log', task.id, '--type', 'progress', '--text', 'First note']);

  const [factFile] = Object.keys(await readFactFiles());
  const factPath = join(home, 'store', 'facts', factFile ?? '');

  await appendFile(factPath, '{"version":1,"kind":"cla');
  await runJson(['claim', task.id, '--holder', 'first']);

  const shown = await runJson<ShownTask>(['show', task.id]);
  const listing = await runJson<{ errors: { path: string }[] }>(['ls']);

  expect(shown.state).toBe('active');
  expect(listing.errors.map((error) => error.path)).toEqual([`${factPath}:2`]);
});

it('clears a lock left by a process that has exited', async () => {
  const task = await createTask('Abandoned lock');
  const child = Bun.spawn(['bun', '-e', '0'], { stdout: 'ignore', stderr: 'ignore' });

  await child.exited;
  await Bun.write(join(home, 'store', '.git', 'tikk.lock'), `${child.pid}\n`);

  const claimed = await run(['claim', task.id, '--holder', 'first']);

  expect(claimed.exitCode).toBe(0);
  expect(await Bun.file(join(home, 'store', '.git', 'tikk.lock')).exists()).toBe(false);
});
