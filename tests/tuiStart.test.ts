import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cliEnvironment } from './cliFixture.ts';

const entryPath = join(import.meta.dir, '..', 'src', 'index.ts');

it('prints the usage error and exits 1 when tikk has no arguments and no terminal', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tikk-start-'));

  try {
    const child = Bun.spawn(['bun', 'run', entryPath], {
      cwd: home,
      env: cliEnvironment(home, join(home, 'store')),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      child.stdout.text(),
      child.stderr.text(),
      child.exited,
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toStartWith('Usage: tikk <');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
