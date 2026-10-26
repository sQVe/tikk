import { expect, it, onTestFinished } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import packageJson from '../package.json' with { type: 'json' };
import { cliEnvironment, waitForBackgroundSync } from './cliFixture.ts';

it('prints the package version from the compiled binary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tikk-binary-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const binary = join(directory, 'tikk');

  const build = Bun.spawnSync(['bun', 'build', '--compile', 'src/index.ts', '--outfile', binary], {
    cwd: join(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(build.stderr.toString()).not.toContain('error');
  expect(build.exitCode).toBe(0);

  const run = Bun.spawnSync([binary, '--version'], { stdout: 'pipe', stderr: 'pipe' });

  expect(run.stdout.toString()).toBe(`${packageJson.version}\n`);
  expect(run.exitCode).toBe(0);
});

const runGit = (args: string[]): string => {
  const run = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });

  expect(run.exitCode).toBe(0);

  return run.stdout.toString();
};

it('syncs a write by the compiled binary to the remote in the background', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tikk-binary-sync-'));
  const storePath = join(directory, 'store');
  const remotePath = join(directory, 'remote.git');
  const work = join(directory, 'work');

  onTestFinished(async () => {
    await waitForBackgroundSync(storePath);
    await rm(directory, { recursive: true, force: true });
  });

  const binary = join(directory, 'tikk');

  const build = Bun.spawnSync(['bun', 'build', '--compile', 'src/index.ts', '--outfile', binary], {
    cwd: join(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(build.exitCode).toBe(0);

  await mkdir(work, { recursive: true });
  runGit(['init', '--bare', '--initial-branch=main', remotePath]);

  const tikk = (args: string[]): string => {
    const run = Bun.spawnSync([binary, ...args, '--json'], {
      cwd: work,
      env: cliEnvironment(directory, storePath),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(run.exitCode).toBe(0);

    return run.stdout.toString();
  };

  tikk(['init', '--remote', remotePath]);

  const before = Number(runGit(['-C', remotePath, 'rev-list', '--count', 'main']).trim());

  const parent = JSON.parse(tikk(['new', 'slice', 'Parent', '--status', 'draft'])) as {
    id: string;
  };

  tikk(['new', 'instruction', 'Compiled instruction', '--parent', parent.id]);

  const deadline = Date.now() + 10_000;
  let after = before;

  while (after <= before && Date.now() < deadline) {
    await Bun.sleep(200);

    const counted = Bun.spawnSync(['git', '-C', remotePath, 'rev-list', '--count', 'main'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });

    after = Number(counted.stdout.toString().trim());
  }

  expect(after).toBeGreaterThan(before);
}, 60_000);
