import { afterEach, beforeEach, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initStore, openStore } from './store.ts';
import type { StoreInitEffects } from './store.ts';
import { nodeStoreFiles } from './storeHarness.ts';

interface InitCalls {
  mkdirs: string[];
  gits: string[][];
  writes: string[];
}

let base = '';

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'tikk-init-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

// Git reads no user config, so the store has no Git identity.
const isolatedGitEnvironment = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

const gitOutput = async (root: string, args: string[]): Promise<string> => {
  const child = Bun.spawn(['git', '-C', root, ...args], {
    env: isolatedGitEnvironment,
    stdout: 'pipe',
    stderr: 'ignore',
  });

  return child.stdout.text();
};

const effects: StoreInitEffects = {
  ...nodeStoreFiles,
  runGit: async (args) => {
    const process = Bun.spawn(['git', ...args], {
      env: isolatedGitEnvironment,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = await new Response(process.stdout).text();
    const code = await process.exited;

    return code === 0
      ? { ok: true, value: stdout }
      : { ok: false, reason: { message: 'git failed' } };
  },
};

it('creates the store once and reports created only the first time', async () => {
  const root = join(base, 'store');
  const first = await initStore(root, effects);
  const second = await initStore(root, effects);

  expect(first).toMatchObject({ ok: true, value: { created: true, store: { root } } });
  expect(second).toMatchObject({ ok: true, value: { created: false, store: { root } } });
  expect(existsSync(join(root, '.git'))).toBe(true);
  expect(await Bun.file(join(root, 'tikk.json')).json()).toEqual({ version: 1 });
});

it('commits tikk.json and a union rule for facts on main, without a Git identity', async () => {
  const root = join(base, 'store');

  await initStore(root, effects);

  const branch = await gitOutput(root, ['branch', '--show-current']);
  const committed = await gitOutput(root, ['ls-tree', '--name-only', 'HEAD']);
  const author = await gitOutput(root, ['log', '-1', '--format=%ae']);

  expect(branch.trim()).toBe('main');
  expect(committed.trim().split('\n')).toEqual(['.gitattributes', 'tikk.json']);
  expect(author.trim()).toBe('tikk@localhost');
  expect(await Bun.file(join(root, '.gitattributes')).text()).toContain('facts/** merge=union');
});

it('adds a missing .gitattributes and the first commit to an existing store, once', async () => {
  const root = join(base, 'store');

  await mkdir(root);
  await gitOutput(root, ['init', '--quiet', '--initial-branch=main']);
  await writeFile(join(root, 'tikk.json'), '{"version": 1}\n');

  const first = await initStore(root, effects);
  const second = await initStore(root, effects);
  const commits = await gitOutput(root, ['rev-list', '--count', 'HEAD']);
  const committed = await gitOutput(root, ['ls-tree', '--name-only', 'HEAD']);

  expect(first).toMatchObject({ ok: true, value: { created: false } });
  expect(second).toMatchObject({ ok: true, value: { created: false } });
  expect(commits.trim()).toBe('1');
  expect(committed.trim().split('\n')).toEqual(['.gitattributes', 'tikk.json']);
});

it('keeps an existing .gitattributes', async () => {
  const root = join(base, 'store');

  await initStore(root, effects);
  await writeFile(join(root, '.gitattributes'), 'custom\n');
  await initStore(root, effects);

  expect(await Bun.file(join(root, '.gitattributes')).text()).toBe('custom\n');
});

it('fails to open a store without tikk.json and names tikk init', async () => {
  const result = await openStore(base, effects);

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain('tikk init');
});

it('fails to open a store with an invalid tikk.json and names the file', async () => {
  const configPath = join(base, 'tikk.json');

  await writeFile(configPath, '{"version": 2}');

  const result = await openStore(base, effects);

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain(configPath);
});

it('does not overwrite an invalid tikk.json on init', async () => {
  const configPath = join(base, 'tikk.json');

  await writeFile(configPath, 'nope');

  const result = await initStore(base, effects);

  expect(result.ok).toBe(false);
  expect(await Bun.file(configPath).text()).toBe('nope');
});

it('fails with a typed reason when the store folder cannot be created', async () => {
  const blocker = join(base, 'blocker');

  await writeFile(blocker, 'a file');

  const result = await initStore(join(blocker, 'store'), effects);

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain(blocker);

  expect(await Bun.file(blocker).text()).toBe('a file');
});

it('fails with a typed reason when tikk.json cannot be written', async () => {
  const root = join(base, 'store');

  const result = await initStore(root, {
    ...effects,
    writeFile: () => Promise.reject(new Error('read-only')),
  });

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain('tikk.json');

  expect(existsSync(join(root, 'tikk.json'))).toBe(false);
});

const codeError = (code: string) => Object.assign(new Error(code), { code });

const throwing = (thrown: unknown) => async (): Promise<never> => {
  await Promise.resolve();

  throw thrown;
};

const recordingEffects = (overrides: Partial<StoreInitEffects>): [StoreInitEffects, InitCalls] => {
  const calls: InitCalls = { mkdirs: [], gits: [], writes: [] };

  const recording: StoreInitEffects = {
    readFile: () => Promise.reject(codeError('ENOENT')),
    mkdir: (directory) => {
      calls.mkdirs.push(directory);

      return Promise.resolve();
    },
    runGit: (args) => {
      calls.gits.push(args);

      return Promise.resolve({ ok: true, value: '' });
    },
    writeFile: (path) => {
      calls.writes.push(path);

      return Promise.resolve();
    },
    ...overrides,
  };

  return [recording, calls];
};

it.each([
  ['an error with another code', codeError('EACCES')],
  ['an error without a code', new Error('broken')],
  ['null', null],
  ['a text', 'ENOENT'],
  ['an object that only has a code', { code: 'ENOENT' }],
])('does not create a store when reading tikk.json fails with %s', async (_name, thrown) => {
  const [recording, calls] = recordingEffects({ readFile: throwing(thrown) });
  const root = join(base, 'store');

  const result = await initStore(root, recording);

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain(join(root, 'tikk.json'));
  expect(calls).toEqual({ mkdirs: [], gits: [], writes: [] });
});

it.each([
  ['null', 'null'],
  ['a text', '"version"'],
  ['a number', '5'],
  ['a list', '[1]'],
  ['an object without a version', '{}'],
])('refuses a tikk.json that holds %s and names the file', async (_name, text) => {
  const root = join(base, 'store');
  const configPath = join(root, 'tikk.json');

  const result = await openStore(root, { readFile: () => Promise.resolve(text) });

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain(configPath);
});

it('refuses a tikk.json that is not JSON and names the file', async () => {
  const root = join(base, 'store');

  const result = await openStore(root, { readFile: () => Promise.resolve('nope') });

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain(join(root, 'tikk.json'));
});

it('reports a read that fails for another reason without saying the store is missing', async () => {
  const root = join(base, 'store');
  const result = await openStore(root, { readFile: throwing(codeError('EACCES')) });

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain(join(root, 'tikk.json'));
  expect(!result.ok && result.reason.message).not.toContain('tikk init');
});

it('names the folder, and runs no git or write, when the store folder cannot be created', async () => {
  const [recording, calls] = recordingEffects({ mkdir: () => Promise.reject(codeError('EACCES')) });
  const root = join(base, 'store');

  const result = await initStore(root, recording);

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain(root);
  expect(calls.gits).toEqual([]);
  expect(calls.writes).toEqual([]);
});

it('returns the git failure and writes no tikk.json when git init fails', async () => {
  const [recording, calls] = recordingEffects({
    runGit: () => Promise.resolve({ ok: false, reason: { message: 'git failed in store' } }),
  });

  const result = await initStore(join(base, 'store'), recording);

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain('store');
  expect(calls.writes).toEqual([]);
});

it('commits with the configured Git identity when one is set', async () => {
  const [recording, calls] = recordingEffects({
    readFile: (path) =>
      path.endsWith('tikk.json')
        ? Promise.resolve('{"version": 1}')
        : Promise.reject(codeError('ENOENT')),
    runGit: (args) => {
      calls.gits.push(args);

      const configured = args.includes('config');
      const noHead = args.includes('rev-parse');

      if (noHead) {
        return Promise.resolve({ ok: false, reason: { message: 'no HEAD' } });
      }

      return Promise.resolve({ ok: true, value: configured ? 'me@example.com\n' : '' });
    },
  });

  await initStore(join(base, 'store'), recording);

  const commit = calls.gits.find((args) => args.includes('commit'));

  expect(commit).toBeDefined();
  expect(commit).not.toContain('user.email=tikk@localhost');
});

const failingOn =
  (subcommand: string, calls: string[][]): StoreInitEffects['runGit'] =>
  (args) => {
    calls.push(args);

    return args.includes(subcommand)
      ? Promise.resolve({ ok: false, reason: { message: `${subcommand} failed` } })
      : effects.runGit(args);
  };

it('fails init and goes no further when the first commit fails', async () => {
  const root = join(base, 'store');
  const calls: string[][] = [];

  const result = await initStore(root, { ...effects, runGit: failingOn('commit', calls) });

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toBe('commit failed');
  expect(calls.at(-1)).toContain('commit');
  expect((await gitOutput(root, ['rev-list', '--all'])).trim()).toBe('');
});

it('fails init on an existing store when the branch rename fails, before any later step', async () => {
  const root = join(base, 'store');

  await mkdir(root);
  await gitOutput(root, ['init', '--quiet', '--initial-branch=master']);
  await writeFile(join(root, 'tikk.json'), '{"version": 1}\n');

  const calls: string[][] = [];
  const result = await initStore(root, { ...effects, runGit: failingOn('branch', calls) });

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toBe('branch failed');
  expect(calls.at(-1)).toContain('branch');
  expect(existsSync(join(root, '.gitattributes'))).toBe(false);
});
