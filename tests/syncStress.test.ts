import { afterEach, beforeEach, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';

import { invariant } from '../src/invariant.ts';
import { createCloneFixtures, createParentSlice, waitForBackgroundSync } from './cliFixture.ts';
import type { CliFixture, CloneFixtures } from './cliFixture.ts';

const processCount = 10;
const durationMilliseconds = Number(Bun.env['TIKK_SYNC_STRESS_MILLISECONDS'] ?? 60_000);

let clones: CloneFixtures | undefined;

beforeEach(async () => {
  clones = await createCloneFixtures('tikk-stress-');
});

afterEach(async () => {
  await clones?.cleanup();
});

const gitText = async (args: string[]): Promise<string> => {
  const child = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });

  const [stdout, stderr, exitCode] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);

  invariant(exitCode === 0, `git ${args.join(' ')} exited with ${exitCode}: ${stderr}`);

  return stdout;
};

const writeLogs = async (
  fixture: CliFixture,
  instructionId: string,
  worker: number,
  deadline: number,
): Promise<string[]> => {
  const recorded: string[] = [];

  for (let index = 0; Date.now() < deadline; index += 1) {
    const text = `stress-${worker}-${index}`;
    const result = await fixture.run(['log', instructionId, '--type', 'progress', '--text', text]);

    if (result.exitCode === 0) {
      recorded.push(text);
    }
  }

  return recorded;
};

const syncRepeatedly = async (fixture: CliFixture, deadline: number): Promise<void> => {
  while (Date.now() < deadline) {
    await fixture.run(['sync']);
    await Bun.sleep(1500);
  }
};

it('ten processes writing logs for 60 seconds while sync runs leave no index.lock, no merge in progress, and every fact line present', async () => {
  invariant(clones !== undefined, 'The clone fixtures should be set up.');

  const { first, remotePath } = clones;

  await first.runChecked(['init', '--remote', remotePath]);

  const parentSlice = await createParentSlice(first);

  const instruction = await first.runJson<{ id: string }>([
    'new',
    'instruction',
    'Stress instruction',
    '--parent',
    parentSlice,
  ]);

  const deadline = Date.now() + durationMilliseconds;

  const writers = Array.from({ length: processCount }, (_, worker) =>
    writeLogs(first, instruction.id, worker, deadline),
  );

  const [recorded] = await Promise.all([Promise.all(writers), syncRepeatedly(first, deadline)]);

  await first.runChecked(['sync']);
  await waitForBackgroundSync(first.storePath);

  const gitDirectory = `${first.storePath}/.git`;

  expect(existsSync(`${gitDirectory}/index.lock`)).toBe(false);
  expect(existsSync(`${gitDirectory}/MERGE_HEAD`)).toBe(false);

  const lines = recorded.flat();

  const files = (await gitText(['-C', remotePath, 'ls-tree', '-r', '--name-only', 'main']))
    .split('\n')
    .filter((file) => file.startsWith('facts/'));

  const contents = await Promise.all(
    files.map((file) => gitText(['-C', remotePath, 'show', `main:${file}`])),
  );

  const remoteFacts = contents.join('');

  expect(lines.length).toBeGreaterThan(0);

  const missing = lines.filter((line) => !remoteFacts.includes(`"${line}"`));

  expect(missing).toEqual([]);
}, 180_000);
