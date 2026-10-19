import { expect, it } from 'bun:test';

import packageJson from '../../package.json' with { type: 'json' };
import { runCli } from './cli.ts';
import { failed, makeEffects, makeSession, makeTicket } from './cliHarness.ts';
import type { EffectsOptions, SessionOptions } from './cliHarness.ts';

const run = async (
  argv: string[],
  sessionOptions: SessionOptions = {},
  effectsOptions: EffectsOptions = {},
) => {
  const fakeSession = makeSession({ tickets: [makeTicket('demo-3467')], ...sessionOptions });
  const fakeEffects = makeEffects({ session: fakeSession, ...effectsOptions });
  const stdout: string[] = [];
  const stderr: string[] = [];

  const exitCode = await runCli(argv, fakeEffects.effects, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });

  return { exitCode, stdout, stderr, fakeSession, fakeEffects };
};

const errorOf = (stdout: string[]): { code: string; message: string } => {
  const parsed = JSON.parse(stdout.join('')) as { error: { code: string; message: string } };

  return parsed.error;
};

it('prints the package version for --version', async () => {
  const { exitCode, stdout, fakeEffects } = await run(['--version']);

  expect(exitCode).toBe(0);
  expect(stdout).toEqual([`${packageJson.version}\n`]);
  expect(fakeEffects.openCalls()).toBe(0);
});

it('prints usage to stderr and exits 1 without a command', async () => {
  const { exitCode, stdout, stderr } = await run([]);

  expect(exitCode).toBe(1);
  expect(stdout).toEqual([]);
  expect(stderr.join('')).toContain('tikk');
  expect(stderr.join('')).not.toContain('undefined');
  expect(stderr.join('')).toEndWith('\n');
});

it('names an unknown command and opens no session', async () => {
  const { exitCode, stderr, fakeEffects } = await run(['bogus']);

  expect(exitCode).toBe(1);
  expect(stderr.join('')).toContain('bogus');
  expect(fakeEffects.openCalls()).toBe(0);
  expect(fakeEffects.initCalls()).toBe(0);
});

it('writes a json error to stdout for an unknown command with --json', async () => {
  const { exitCode, stdout, stderr } = await run(['bogus', '--json']);
  const error = errorOf(stdout);

  expect(exitCode).toBe(1);
  expect(stderr).toEqual([]);
  expect(error.code).toBe('invalidArguments');
  expect(error.message).toContain('bogus');
  expect(stdout.join('')).toEndWith('\n');
});

it('runs init without opening a session', async () => {
  const { exitCode, stdout, fakeEffects } = await run(['init', '--json']);

  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout.join(''))).toEqual({ store: '/store', created: true });
  expect(fakeEffects.initCalls()).toBe(1);
  expect(fakeEffects.openCalls()).toBe(0);
});

it('writes text output to stdout and exits 0', async () => {
  const { exitCode, stdout, stderr, fakeSession } = await run(['show', 'demo-3467']);

  expect(exitCode).toBe(0);
  expect(stdout.join('')).toContain('demo-3467');
  expect(stdout.join('')).toEndWith('\n');
  expect(stderr).toEqual([]);
  expect(fakeSession.refreshes()).toBe(1);
});

it('writes json output with a trailing newline', async () => {
  const { stdout } = await run(['show', 'demo-3467', '--json']);

  expect(stdout).toHaveLength(1);
  expect(stdout[0]).toEndWith('\n');
  expect(JSON.parse(stdout.join(''))).toMatchObject({ id: 'demo-3467' });
});

it('writes nothing for an empty text listing', async () => {
  const { exitCode, stdout, stderr } = await run(['ls'], { tickets: [] });

  expect(exitCode).toBe(0);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([]);
});

it('still writes json for an empty listing', async () => {
  const { stdout } = await run(['ls', '--json'], { tickets: [] });

  expect(JSON.parse(stdout.join(''))).toEqual({ tickets: [], errors: [] });
});

it('dispatches every session command', async () => {
  const created = makeTicket('demo-3469');
  const newRun = await run(['new', 'task', 'Made', '--json'], { created });
  const listRun = await run(['ls', '--json']);
  const editRun = await run(['edit', 'demo-3467', '--hash', 'h', '--title', 'X', '--json']);

  expect(newRun.fakeSession.creates).toHaveLength(1);
  expect(listRun.fakeSession.listOptions).toHaveLength(1);
  expect(editRun.fakeSession.writes).toHaveLength(1);
});

it('writes the failure message with a newline to stderr', async () => {
  const { exitCode, stdout, stderr } = await run(['show', 'demo-3468']);

  expect(exitCode).toBe(1);
  expect(stdout).toEqual([]);
  expect(stderr.join('')).toContain('demo-3468');
  expect(stderr.join('')).toEndWith('\n');
});

it('writes the failure as json with its code', async () => {
  const { exitCode, stdout, stderr } = await run(['show', 'demo-3468', '--json']);

  expect(exitCode).toBe(1);
  expect(stderr).toEqual([]);
  expect(errorOf(stdout).code).toBe('notFound');
  expect(stdout.join('')).toEndWith('\n');
});

it('passes a session failure through with its code', async () => {
  const { exitCode, stdout, fakeSession } = await run(
    ['show', 'demo-3467', '--json'],
    {},
    {
      overrides: {
        openSession: () =>
          Promise.resolve({
            ok: false,
            reason: { code: 'notInitialized', message: 'No store at /store.' },
          }),
      },
    },
  );

  const error = errorOf(stdout);

  expect(exitCode).toBe(1);
  expect(error.code).toBe('notInitialized');
  expect(error.message).toContain('/store');
  expect(fakeSession.refreshes()).toBe(0);
});

it('returns a storeError and closes the session when the refresh fails', async () => {
  const { exitCode, stdout, fakeSession } = await run(['new', 'task', 'Title', '--json'], {
    overrides: {
      refresh: () => Promise.resolve({ ok: false, reason: { message: 'Cannot scan /store.' } }),
    },
  });

  const error = errorOf(stdout);

  expect(exitCode).toBe(1);
  expect(error.code).toBe('storeError');
  expect(error.message).toContain('/store');
  expect(fakeSession.creates).toEqual([]);
  expect(fakeSession.disposed()).toBe(true);
});

it('closes the session after a command finishes', async () => {
  const { fakeSession } = await run(['show', 'demo-3467']);

  expect(fakeSession.disposed()).toBe(true);
});

it('does not run a command when init fails to create a store', async () => {
  const { exitCode, stdout } = await run(
    ['init', '--json'],
    {},
    {
      overrides: { initStore: () => failed('Cannot create /store.') },
    },
  );

  expect(exitCode).toBe(1);
  expect(errorOf(stdout).code).toBe('storeError');
});
