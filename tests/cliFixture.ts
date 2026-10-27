import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';

export interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CliFixtureOptions {
  machine?: string;
  remotePath?: string;
  // A folder that goes first on PATH, such as one that holds a fake gh.
  pathPrefix?: string;
}

export interface CliFixture {
  home: string;
  storePath: string;
  remotePath: string;
  // A path replaces PATH for this one run.
  run: (args: string[], runOptions?: { path?: string }) => Promise<CliRun>;
  runChecked: (args: string[]) => Promise<CliRun>;
  runJson: <Shape>(args: string[]) => Promise<Shape>;
  cleanup: () => Promise<void>;
}

export interface CloneFixtures {
  remotePath: string;
  first: CliFixture;
  second: CliFixture;
  cleanup: () => Promise<void>;
}

const entryPath = join(import.meta.dir, '..', 'src', 'index.ts');

const writeMachineConfig = async (home: string, machine: string): Promise<void> => {
  const configDirectory = join(home, '.config', 'tikk');

  await mkdir(configDirectory, { recursive: true });
  await writeFile(join(configDirectory, 'config.json'), JSON.stringify({ machine }));
};

// Git reads no user or system config, so the store commits as tikk.
export const cliEnvironment = (home: string, storePath: string): Record<string, string> => ({
  ...Bun.env,
  HOME: home,
  TIKK_HOME: storePath,
  GIT_CONFIG_NOSYSTEM: '1',
});

// A background sync child owns these files while it waits and while it runs, and it must not meet a
// deleted store.
export const waitForBackgroundSync = async (storePath: string): Promise<void> => {
  const files = ['tikk.sync-scheduled', 'tikk.sync-running'].map((name) =>
    join(storePath, '.git', name),
  );

  const deadline = Date.now() + 60_000;

  while (files.some((file) => existsSync(file)) && Date.now() < deadline) {
    await Bun.sleep(100);
  }
};

// Runs the real CLI in a child process against a store in a temporary home.
export const createCliFixture = async (
  prefix: string,
  options: CliFixtureOptions = {},
): Promise<CliFixture> => {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const work = join(home, 'work');
  const storePath = join(home, 'store');
  const remotePath = options.remotePath ?? join(home, 'remote.git');

  await Bun.write(join(work, '.keep'), '');

  if (options.machine !== undefined) {
    await writeMachineConfig(home, options.machine);
  }

  const run = async (args: string[], runOptions: { path?: string } = {}): Promise<CliRun> => {
    const environment = cliEnvironment(home, storePath);

    if (options.pathPrefix !== undefined) {
      environment.PATH = `${options.pathPrefix}:${Bun.env.PATH ?? ''}`;
    }

    if (runOptions.path !== undefined) {
      environment.PATH = runOptions.path;
    }

    const child = Bun.spawn(['bun', 'run', entryPath, ...args, '--json'], {
      cwd: work,
      env: environment,
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

  const cleanup = async (): Promise<void> => {
    await waitForBackgroundSync(storePath);
    await rm(home, { recursive: true, force: true });
  };

  return { home, storePath, remotePath, run, runChecked, runJson, cleanup };
};

const runGit = async (args: string[]): Promise<void> => {
  const child = Bun.spawn(['git', ...args], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
  const [stderr, exitCode] = await Promise.all([child.stderr.text(), child.exited]);

  invariant(exitCode === 0, `git ${args.join(' ')} exited with ${exitCode}.\nstderr: ${stderr}`);
};

export const createParentSlice = async (fixture: CliFixture): Promise<string> => {
  const created = await fixture.runJson<{ id: string }>([
    'new',
    'slice',
    'Parent slice',
    '--status',
    'draft',
  ]);

  return created.id;
};

// Two clients with their own homes and machine names, which share one bare remote in the first
// home. Neither store exists until a test runs `tikk init`.
export const createCloneFixtures = async (prefix: string): Promise<CloneFixtures> => {
  const first = await createCliFixture(prefix, { machine: 'first' });
  const remotePath = first.remotePath;

  await runGit(['init', '--bare', '--initial-branch=main', remotePath]);

  const second = await createCliFixture(prefix, { machine: 'second', remotePath });

  const cleanup = async (): Promise<void> => {
    await second.cleanup();
    await first.cleanup();
  };

  return { remotePath, first, second, cleanup };
};
