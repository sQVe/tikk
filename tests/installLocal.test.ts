import { expect, it, onTestFinished } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import packageJson from '../package.json' with { type: 'json' };
import { cliEnvironment, waitForBackgroundSync } from './cliFixture.ts';

const checkout = join(import.meta.dir, '..');

const install = (installDirectory: string): ReturnType<typeof Bun.spawnSync> =>
  Bun.spawnSync(['bun', 'run', 'install:local'], {
    cwd: checkout,
    env: { ...process.env, TIKK_INSTALL_DIR: installDirectory },
    stdout: 'pipe',
    stderr: 'pipe',
  });

it('installs an executable tikk into TIKK_INSTALL_DIR', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tikk-install-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const installDirectory = join(directory, 'bin');
  const elsewhere = join(directory, 'elsewhere');
  await Bun.write(join(elsewhere, '.keep'), '');

  const installed = install(installDirectory);

  expect(installed.exitCode).toBe(0);

  const binary = join(installDirectory, 'tikk');
  const info = await stat(binary);

  expect(info.mode & 0o111).not.toBe(0);

  const run = Bun.spawnSync([binary, '--version'], {
    cwd: elsewhere,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(run.stdout.toString()).toBe(`${packageJson.version}\n`);
  expect(run.exitCode).toBe(0);
}, 60_000);

it('runs init and ready from outside the checkout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tikk-install-run-'));
  const storePath = join(directory, 'store');
  const work = join(directory, 'work');

  onTestFinished(async () => {
    await waitForBackgroundSync(storePath);
    await rm(directory, { recursive: true, force: true });
  });

  await Bun.write(join(work, '.keep'), '');

  const installDirectory = join(directory, 'bin');
  const installed = install(installDirectory);

  expect(installed.exitCode).toBe(0);

  const binary = join(installDirectory, 'tikk');

  for (const command of ['init', 'ready']) {
    const run = Bun.spawnSync([binary, command, '--json'], {
      cwd: work,
      env: cliEnvironment(directory, storePath),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(run.stderr.toString()).toBe('');
    expect(run.exitCode).toBe(0);
  }
}, 60_000);
