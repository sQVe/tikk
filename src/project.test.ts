import { expect, it } from 'bun:test';

import { readSettings } from './config.ts';
import type { ConfigFileRead } from './config.ts';
import { resolveMachine, resolveProject } from './project.ts';
import type { GitOutcome } from './project.ts';

const configPath = '/home/me/.config/tikk/config.json';

const configRead = (config: string | undefined): ConfigFileRead =>
  config === undefined ? { kind: 'missing' } : { kind: 'text', text: config };

const settingsWith = (config?: string | ConfigFileRead) => () =>
  readSettings('/home/me', {
    readFile: (path) => {
      if (path !== configPath) {
        return { kind: 'missing' };
      }

      return typeof config === 'object' ? config : configRead(config);
    },
  });

const resolveWith = (git: GitOutcome, config?: string | ConfigFileRead) =>
  resolveProject('/work/repo', {
    runGit: async () => git,
    readSettings: settingsWith(config),
    hostName: 'Build-Host',
  });

it('gives personal outside a Git repository', async () => {
  expect(await resolveWith({ kind: 'failed' })).toMatchObject({ ok: true, value: 'personal' });
});

it('uses the repository name from an scp-style origin', async () => {
  const origin: GitOutcome = { kind: 'output', stdout: 'git@github.com:sQVe/tikk.git\n' };

  expect(await resolveWith(origin)).toMatchObject({ ok: true, value: 'tikk' });
});

it.each([
  'https://github.com/sQVe/tikk',
  'https://github.com/sQVe/tikk.git',
  'ssh://git@github.com/sQVe/tikk.git',
])('reads the repository from %s', async (url) => {
  expect(await resolveWith({ kind: 'output', stdout: url })).toMatchObject({
    ok: true,
    value: 'tikk',
  });
});

it('uses a mapped project and matches the key without case', async () => {
  const origin: GitOutcome = { kind: 'output', stdout: 'git@github.com:sQVe/tikk.git' };
  const config = JSON.stringify({ projects: { 'sqve/TIKK': 'tk' } });

  expect(await resolveWith(origin, config)).toMatchObject({ ok: true, value: 'tk' });
});

it('fails with the config file name when the config is malformed', async () => {
  const origin: GitOutcome = { kind: 'output', stdout: 'git@github.com:sQVe/tikk.git' };
  const result = await resolveWith(origin, '{ nope');

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain(configPath);
});

it('fails when the config has the wrong shape', async () => {
  const origin: GitOutcome = { kind: 'output', stdout: 'git@github.com:sQVe/tikk.git' };
  const result = await resolveWith(origin, '{"projects": []}');

  expect(!result.ok && result.reason.message).toContain(configPath);
});

it('fails and names the repository when its name is not a project name', async () => {
  const origin: GitOutcome = { kind: 'output', stdout: 'git@github.com:sQVe/_odd.git' };
  const result = await resolveWith(origin);

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain('sQVe/_odd');
});

it('fails when git cannot start', async () => {
  const result = await resolveWith({ kind: 'unavailable', message: 'spawn-failure-detail' });

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain('spawn-failure-detail');
});

it('fails with the config file name when the config cannot be read', async () => {
  const origin: GitOutcome = { kind: 'output', stdout: 'git@github.com:sQVe/tikk.git' };
  const result = await resolveWith(origin, { kind: 'failed' });

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain(configPath);
});

it('asks git for the origin URL of the working folder', async () => {
  const calls: string[][] = [];

  await resolveProject('/work/repo', {
    runGit: async (args) => {
      calls.push(args);

      return { kind: 'failed' };
    },
    readSettings: settingsWith(),
    hostName: 'host',
  });

  expect(calls).toEqual([['-C', '/work/repo', 'remote', 'get-url', 'origin']]);
});

it('gives personal for an origin it cannot read as a repository', async () => {
  const result = await resolveWith({ kind: 'output', stdout: 'not a remote url' });

  expect(result).toMatchObject({ ok: true, value: 'personal' });
});

const machineWith = (config: string | undefined, hostName = 'Build-Host') =>
  resolveMachine({
    runGit: async () => ({ kind: 'failed' }),
    readSettings: settingsWith(config),
    hostName,
  });

it('reads the machine from config', async () => {
  const config = JSON.stringify({ machine: 'Laptop-1' });

  expect(machineWith(config)).toEqual({ ok: true, value: 'laptop-1' });
});

it('accepts a config that has only a machine and no projects', async () => {
  const config = JSON.stringify({ machine: 'laptop' });

  expect(machineWith(config)).toEqual({ ok: true, value: 'laptop' });
});

it.each([undefined, '{}', JSON.stringify({ projects: { 'a/b': 'c' } })])(
  'defaults the machine to the lowercased host name for config %j',
  async (config) => {
    expect(machineWith(config)).toEqual({ ok: true, value: 'build-host' });
  },
);

it.each(['bad name', '-start', '', 'a/b'])('fails on the invalid machine name %j', async (name) => {
  const result = machineWith(JSON.stringify({ machine: name }));

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain('machine');
});

it('fails when the host name is not a valid machine name', async () => {
  expect(machineWith(undefined, 'my host')).toMatchObject({ ok: false });
});

it('still resolves a project when the config has only a machine', async () => {
  const origin: GitOutcome = { kind: 'output', stdout: 'git@github.com:sQVe/tikk.git' };

  expect(await resolveWith(origin, JSON.stringify({ machine: 'laptop' }))).toMatchObject({
    ok: true,
    value: 'tikk',
  });
});
