import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';

export interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CliFixture {
  home: string;
  storePath: string;
  run: (args: string[]) => Promise<CliRun>;
  runChecked: (args: string[]) => Promise<CliRun>;
  runJson: <Shape>(args: string[]) => Promise<Shape>;
  cleanup: () => Promise<void>;
}

const entryPath = join(import.meta.dir, '..', 'src', 'index.ts');

// Runs the real CLI in a child process against a store in a temporary home.
export const createCliFixture = async (prefix: string): Promise<CliFixture> => {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const work = join(home, 'work');
  const storePath = join(home, 'store');

  await Bun.write(join(work, '.keep'), '');

  const run = async (args: string[]): Promise<CliRun> => {
    const child = Bun.spawn(['bun', 'run', entryPath, ...args, '--json'], {
      cwd: work,
      env: { ...process.env, HOME: home, TIKK_HOME: storePath },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      child.stdout.text(),
      child.stderr.text(),
      child.exited,
    ]);

    return { exitCode, stdout, stderr };
  };

  const runChecked = async (args: string[]): Promise<CliRun> => {
    const result = await run(args);

    invariant(
      result.exitCode === 0,
      `tikk ${args.join(' ')} exited with ${result.exitCode}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );

    return result;
  };

  const runJson = async <Shape>(args: string[]): Promise<Shape> => {
    const result = await runChecked(args);

    return JSON.parse(result.stdout) as Shape;
  };

  const cleanup = (): Promise<void> => rm(home, { recursive: true, force: true });

  return { home, storePath, run, runChecked, runJson, cleanup };
};
