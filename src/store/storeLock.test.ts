import { expect, it } from 'bun:test';

import { acquireStoreLock } from './store.ts';
import type { StoreLockFunctions } from './store.ts';

interface Harness {
  functions: StoreLockFunctions;
  files: Map<string, string>;
  modified: Map<string, number>;
  advance: (milliseconds: number) => void;
  sleeps: number[];
}

const store = { root: '/store' };
const lockPath = '/store/.git/tikk.lock';
const breakerPath = '/store/.git/tikk.lock.break';

const codeError = (code: string): Error => Object.assign(new Error(code), { code });

const harness = (livePids: number[], pid = 100): Harness => {
  const files = new Map<string, string>();
  const modified = new Map<string, number>();
  const sleeps: number[] = [];
  let clock = 0;

  const functions: StoreLockFunctions = {
    pid,
    createExclusive: async (path, text) => {
      if (files.has(path)) {
        throw codeError('EEXIST');
      }

      files.set(path, text);
      modified.set(path, clock);
    },
    modifiedAt: async (path) => {
      const time = modified.get(path);

      if (time === undefined) {
        throw codeError('ENOENT');
      }

      return time;
    },
    readFile: async (path) => {
      const text = files.get(path);

      if (text === undefined) {
        throw codeError('ENOENT');
      }

      return text;
    },
    unlink: async (path) => {
      if (!files.delete(path)) {
        throw codeError('ENOENT');
      }
    },
    isProcessAlive: (candidate) => livePids.includes(candidate),
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
    now: () => clock,
  };

  const advance = (milliseconds: number) => {
    clock += milliseconds;
  };

  return { functions, files, modified, advance, sleeps };
};

it('clears a lock held by a process that no longer exists', async () => {
  const { functions, files } = harness([]);

  files.set(lockPath, '999\n');

  const result = await acquireStoreLock(functions, store);

  expect(result.ok).toBe(true);
  expect(files.get(lockPath)).toBe('100\n');
});

it('clears a lock that holds no valid PID', async () => {
  const { functions, files } = harness([]);

  files.set(lockPath, 'garbage');

  expect((await acquireStoreLock(functions, store)).ok).toBe(true);
  expect(files.get(lockPath)).toBe('100\n');
});

it('reports locked with the PID when a live process keeps the lock past the timeout', async () => {
  const { functions, files, sleeps } = harness([999]);

  files.set(lockPath, '999\n');

  const result = await acquireStoreLock(functions, store);

  expect(result).toMatchObject({ ok: false, reason: { kind: 'locked' } });
  expect(!result.ok && result.reason.message).toContain('999');
  expect(files.get(lockPath)).toBe('999\n');
  expect(sleeps.length).toBeGreaterThan(1);
  expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(10);
  expect(Math.max(...sleeps)).toBeLessThanOrEqual(50);
  expect(sleeps.reduce((sum, value) => sum + value, 0)).toBeGreaterThanOrEqual(5000);
});

it('takes the lock once the live holder releases it', async () => {
  const { functions, files } = harness([999]);

  files.set(lockPath, '999\n');

  const sleep = functions.sleep;

  functions.sleep = async (milliseconds) => {
    await sleep(milliseconds);
    files.delete(lockPath);
  };

  expect((await acquireStoreLock(functions, store)).ok).toBe(true);
  expect(files.get(lockPath)).toBe('100\n');
});

it('removes its own lock file on release', async () => {
  const { functions, files } = harness([]);
  const result = await acquireStoreLock(functions, store);

  expect(result.ok).toBe(true);

  if (result.ok) {
    await result.value.release();
  }

  expect(files.has(lockPath)).toBe(false);
});

it('leaves a lock file that another process holds when it releases', async () => {
  const { functions, files } = harness([]);
  const result = await acquireStoreLock(functions, store);

  files.set(lockPath, '555\n');

  if (result.ok) {
    await result.value.release();
  }

  expect(files.get(lockPath)).toBe('555\n');
});

it('fails when the lock file cannot be created', async () => {
  const { functions } = harness([]);

  functions.createExclusive = async () => {
    throw codeError('EACCES');
  };

  expect(await acquireStoreLock(functions, store)).toMatchObject({
    ok: false,
    reason: { kind: 'failed' },
  });
});

it('lets only one of two acquirers that saw the same stale lock hold it', async () => {
  const { functions: first, files } = harness([100, 200]);

  files.set(lockPath, '999\n');

  let firstResult: Awaited<ReturnType<typeof acquireStoreLock>> | undefined;
  let interleaved = false;

  // The second acquirer has read the stale PID when the first one clears the lock and takes it.
  const second: StoreLockFunctions = {
    ...first,
    pid: 200,
    readFile: async (path) => {
      const text = await first.readFile(path);

      if (!interleaved) {
        interleaved = true;
        firstResult = await acquireStoreLock(first, store);
      }

      return text;
    },
  };

  const secondResult = await acquireStoreLock(second, store);

  expect(firstResult?.ok).toBe(true);
  expect(secondResult).toMatchObject({ ok: false, reason: { kind: 'locked' } });
  expect(files.get(lockPath)).toBe('100\n');
  expect(files.has(breakerPath)).toBe(false);
});

it('retries while another process holds the breaker', async () => {
  const { functions, files, sleeps } = harness([]);

  files.set(lockPath, '999\n');
  files.set(breakerPath, '555\n');

  const sleep = functions.sleep;

  functions.sleep = async (milliseconds) => {
    await sleep(milliseconds);
    files.delete(breakerPath);
  };

  expect((await acquireStoreLock(functions, store)).ok).toBe(true);
  expect(sleeps.length).toBe(1);
  expect(files.get(lockPath)).toBe('100\n');
});

it('removes a breaker older than 5 seconds', async () => {
  const { functions, files, modified, advance } = harness([]);

  files.set(lockPath, '999\n');
  files.set(breakerPath, '555\n');
  modified.set(breakerPath, 0);
  advance(5001);

  expect((await acquireStoreLock(functions, store)).ok).toBe(true);
  expect(files.get(lockPath)).toBe('100\n');
  expect(files.has(breakerPath)).toBe(false);
});
