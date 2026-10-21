import { expect, it } from 'bun:test';

import { runBackgroundSync, scheduleSync } from './syncSchedule.ts';
import type { SyncScheduleFunctions } from './syncSchedule.ts';

interface Fake {
  functions: SyncScheduleFunctions;
  files: Map<string, string>;
  started: () => number;
  sleeps: number[];
}

interface FakeOptions {
  remote?: boolean;
  alive?: number[];
  startPid?: number | undefined;
  pid?: number;
}

const root = '/store';
const marker = '/store/.git/tikk.sync-scheduled';
const running = '/store/.git/tikk.sync-running';

const makeFake = (options: FakeOptions = {}): Fake => {
  const files = new Map<string, string>();
  const sleeps: number[] = [];
  let startCount = 0;
  let suffix = 0;
  const pid = options.pid ?? 100;
  const alive = options.alive ?? [];

  const functions: SyncScheduleFunctions = {
    pid,
    runGit: () =>
      Promise.resolve(
        options.remote === false
          ? { ok: false, reason: { message: 'no remote' } }
          : { ok: true, value: 'url' },
      ),
    writeFile: (path, text) => {
      files.set(path, text);

      return Promise.resolve();
    },
    link: (existing, path) => {
      if (files.has(path)) {
        return Promise.reject(Object.assign(new Error('exists'), { code: 'EEXIST' }));
      }

      files.set(path, files.get(existing) ?? '');

      return Promise.resolve();
    },
    rename: (from, to) => {
      files.set(to, files.get(from) ?? '');
      files.delete(from);

      return Promise.resolve();
    },
    unlink: (path) => {
      files.delete(path);

      return Promise.resolve();
    },
    readFile: async (path) => {
      const text = files.get(path);

      if (text === undefined) {
        throw new Error('missing');
      }

      return text;
    },
    randomSuffix: () => {
      suffix += 1;

      return String(suffix);
    },
    isProcessAlive: (candidate) => alive.includes(candidate),
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);

      return Promise.resolve();
    },
    startBackground: () => {
      startCount += 1;

      return 'startPid' in options ? options.startPid : 555;
    },
  };

  return { functions, files, started: () => startCount, sleeps };
};

it('starts no process when the store has no remote', async () => {
  const fake = makeFake({ remote: false });

  await scheduleSync(fake.functions, root);

  expect(fake.started()).toBe(0);
  expect(fake.files.size).toBe(0);
});

it('starts one child and records its PID in the marker', async () => {
  const fake = makeFake();

  await scheduleSync(fake.functions, root);

  expect(fake.started()).toBe(1);
  expect(fake.files.get(marker)).toBe('555\n');
  expect([...fake.files.keys()]).toEqual([marker]);
});

it('starts nothing while the marker holder is alive', async () => {
  const fake = makeFake({ alive: [555] });

  await scheduleSync(fake.functions, root);
  await scheduleSync(fake.functions, root);

  expect(fake.started()).toBe(1);
});

it('replaces a marker whose holder is dead', async () => {
  const fake = makeFake({ alive: [] });

  fake.files.set(marker, '555\n');

  await scheduleSync(fake.functions, root);

  expect(fake.started()).toBe(1);
  expect(fake.files.get(marker)).toBe('555\n');
});

it('removes the marker when the child cannot start', async () => {
  const fake = makeFake({ startPid: undefined });

  await scheduleSync(fake.functions, root);

  expect(fake.files.has(marker)).toBe(false);
});

it('waits, frees the marker, and syncs while it holds the running file', async () => {
  const fake = makeFake({ pid: 555 });
  const seen: string[] = [];

  fake.files.set(marker, '555\n');

  await runBackgroundSync(fake.functions, root, () => {
    seen.push(`marker ${fake.files.has(marker)} running ${fake.files.get(running)}`);

    return Promise.resolve();
  });

  expect(fake.sleeps[0]).toBeGreaterThanOrEqual(3000);
  expect(seen).toEqual(['marker false running 555\n']);
  expect(fake.files.has(running)).toBe(false);
});

const failingSync = (): Promise<void> => {
  throw new Error('boom');
};

it('releases the running file when the sync throws', async () => {
  const fake = makeFake({ pid: 555 });

  await runBackgroundSync(fake.functions, root, failingSync).catch(() => undefined);

  expect(fake.files.has(running)).toBe(false);
});

it('leaves a marker that another process owns', async () => {
  const fake = makeFake({ pid: 555 });

  fake.files.set(marker, '777\n');

  await runBackgroundSync(fake.functions, root, () => Promise.resolve());

  expect(fake.files.get(marker)).toBe('777\n');
});
