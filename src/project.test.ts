import { expect, it } from 'bun:test';

import { resolveProject } from './project.ts';
import type { ConfigRead, GitOutcome } from './project.ts';

const configPath = '/home/me/.config/tikk/config.json';

const configRead = (config: string | undefined): ConfigRead =>
  config === undefined ? { kind: 'missing' } : { kind: 'text', text: config };

const resolveWith = (git: GitOutcome, config?: string | ConfigRead) =>
  resolveProject('/work/repo', {
    runGit: async () => git,
    readConfigFile: async (path) => {
      if (path !== configPath) {
        return { kind: 'missing' };
      }

      return typeof config === 'object' ? config : configRead(config);
    },
    homeDirectory: '/home/me',
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
  const result = await resolveWith({ kind: 'unavailable', message: 'ENOENT' });

  expect(result.ok).toBe(false);
});

it('fails with the config file name when the config cannot be read', async () => {
  const origin: GitOutcome = { kind: 'output', stdout: 'git@github.com:sQVe/tikk.git' };
  const result = await resolveWith(origin, { kind: 'failed' });

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.message).toContain(configPath);
});
