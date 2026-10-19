import { expect, it, onTestFinished } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import packageJson from '../package.json' with { type: 'json' };

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
