import {
  mkdtemp,
  mkdir,
  link,
  lstat,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CliEffects } from './cli/cli.ts';
import { parseFactLine } from './fact/fact.ts';
import { resolveMachine } from './project.ts';
import type { ProjectEffects } from './project.ts';
import {
  acquireStoreLock,
  appendFact,
  commitArguments,
  newIdSuffix,
  openStore,
} from './store/store.ts';
import { factFiles, openFailureCode, storeFiles, storeLock } from './storeEffects.ts';
import {
  fetchOrigin,
  initRemoteStore,
  mergeFetched,
  runBackgroundSync,
  scheduleSync,
  settlingPaths,
  syncStore,
} from './sync/sync.ts';
import type {
  RemoteInitFunctions,
  SyncFunctions,
  SyncReason,
  SyncScheduleFunctions,
} from './sync/sync.ts';

// Git must fail instead of asking for credentials, since no one may be at the terminal.
const runSyncGit: SyncFunctions['runGit'] = async (args, signal) => {
  try {
    // A timed-out call runs in its own process group, so the kill also reaches the transport
    // process (such as ssh) that Git started.
    const child = Bun.spawn(['git', ...args], {
      env: { ...Bun.env, GIT_TERMINAL_PROMPT: '0' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: signal !== undefined,
    });

    signal?.addEventListener('abort', () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      child.stdout.text(),
      child.stderr.text(),
      child.exited,
    ]);

    if (exitCode === 0) {
      return { ok: true, value: stdout };
    }

    return { ok: false, reason: { message: `"git ${args.join(' ')}" failed: ${stderr.trim()}` } };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'git did not start.';

    return { ok: false, reason: { message: `Cannot run git: ${message}` } };
  }
};

const writeBlob: SyncFunctions['writeBlob'] = async (root, text) => {
  const child = Bun.spawn(['git', '-C', root, 'hash-object', '-w', '--stdin'], {
    stdin: new TextEncoder().encode(text),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);

  if (exitCode === 0) {
    return { ok: true, value: stdout };
  }

  return { ok: false, reason: { message: `"git hash-object" failed: ${stderr.trim()}` } };
};

// A compiled binary runs itself. Otherwise the child runs this script with the same Bun.
const backgroundCommand = (): string[] => {
  const compiled = Bun.main.startsWith('/$bunfs/');
  const entry = compiled ? [] : ['run', Bun.main];

  return [process.execPath, ...entry, 'sync', '--background'];
};

const syncFailureCode = (reason: SyncReason): 'conflict' | 'locked' | 'storeError' =>
  reason.kind === 'failed' ? 'storeError' : reason.kind;

export const createSyncEffects = (
  storeRoot: string,
  initLocalStore: CliEffects['initStore'],
  projectEffects: ProjectEffects,
): Pick<
  CliEffects,
  | 'initRemoteStore'
  | 'syncStore'
  | 'runBackgroundSync'
  | 'scheduleSync'
  | 'fetchRemote'
  | 'mergeFetched'
> => {
  const listAliases: SyncFunctions['listAliases'] = async () => {
    const machine = resolveMachine(projectEffects);

    if (!machine.ok) {
      return [];
    }

    const directory = join(storeRoot, 'facts', machine.value);
    const names = await readdir(directory).catch(() => []);

    const jsonlNames = names.filter((name) => name.endsWith('.jsonl'));

    const perFile = await Promise.all(
      jsonlNames.map(async (name) => {
        const text = await readFile(join(directory, name), 'utf8').catch(() => '');
        const path = join('facts', machine.value, name);

        return text
          .split('\n')
          .filter((line) => line !== '')
          .flatMap((line) => {
            const parsed = parseFactLine(line);

            return parsed.ok && parsed.value.kind === 'alias'
              ? [{ from: parsed.value.from, to: parsed.value.ticket, path }]
              : [];
          });
      }),
    );

    return perFile.flat();
  };

  const syncFunctions: SyncFunctions = {
    runGit: runSyncGit,
    writeBlob,
    listAliases,
    commitArguments: (root) => commitArguments(runSyncGit, root),
    lockStore: () => acquireStoreLock(storeLock, { root: storeRoot }),
    stat: (path) => stat(path),
    lstat: (path) => lstat(path),
    readFile: (path) => readFile(path, 'utf8'),
    now: () => Date.now(),
    readdir: (directory) => readdir(directory),
    rename: (from, to) => rename(from, to),
    link: (existingPath, newPath) => link(existingPath, newPath),
    unlink: (path) => unlink(path),
    randomIdSuffix: () => newIdSuffix(),
    appendAlias: async (alias) => {
      const machine = resolveMachine(projectEffects);

      if (!machine.ok) {
        return { ok: false, reason: { message: machine.reason.message } };
      }

      const fact = { version: 1, kind: 'alias', machine: machine.value, ...alias } as const;
      const appended = await appendFact(factFiles, { root: storeRoot }, machine.value, fact);

      return appended.ok ? appended : { ok: false, reason: { message: appended.reason.message } };
    },
  };

  const startBackground = (): number | undefined => {
    const child = Bun.spawn(backgroundCommand(), {
      detached: true,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });

    child.unref();

    return child.pid;
  };

  const scheduleFunctions: SyncScheduleFunctions = {
    pid: process.pid,
    runGit: runSyncGit,
    writeFile: storeLock.writeFile,
    link: storeLock.link,
    rename: (from, to) => rename(from, to),
    unlink: storeLock.unlink,
    readFile: storeLock.readFile,
    randomSuffix: storeLock.randomSuffix,
    isProcessAlive: storeLock.isProcessAlive,
    sleep: storeLock.sleep,
    startBackground,
  };

  const remoteInitFunctions: RemoteInitFunctions = {
    ...syncFunctions,
    initStore: initLocalStore,
    makeTempFolder: async (prefix) => {
      await mkdir(dirname(prefix), { recursive: true });

      return mkdtemp(prefix);
    },
    removeTree: (path) => rm(path, { recursive: true, force: true }),
  };

  const runSync: CliEffects['syncStore'] = async () => {
    const store = await openStore(storeRoot, storeFiles);

    if (!store.ok) {
      const code = openFailureCode(storeRoot);

      return { ok: false, reason: { code, message: store.reason.message } };
    }

    const synced = await syncStore(syncFunctions, store.value.root, {
      allowUnrelatedHistories: false,
    });

    if (!synced.ok) {
      return {
        ok: false,
        reason: { code: syncFailureCode(synced.reason), message: synced.reason.message },
      };
    }

    return synced;
  };

  const runBackground: CliEffects['runBackgroundSync'] = async () => {
    const store = await openStore(storeRoot, storeFiles);

    if (store.ok) {
      await runBackgroundSync(scheduleFunctions, store.value.root, async () => {
        const synced = await runSync();

        if (!synced.ok) {
          return false;
        }

        const settling = await settlingPaths(syncFunctions, store.value.root, synced.value.pending);

        return settling.length > 0;
      });
    }
  };

  const runScheduleSync: CliEffects['scheduleSync'] = () =>
    scheduleSync(scheduleFunctions, storeRoot);

  const runFetch: CliEffects['fetchRemote'] = () => fetchOrigin(syncFunctions, storeRoot);

  const runMergeFetched: CliEffects['mergeFetched'] = async () => {
    await mergeFetched(syncFunctions, storeRoot);
  };

  const runRemoteInit: CliEffects['initRemoteStore'] = async (url) => {
    const initialized = await initRemoteStore(remoteInitFunctions, storeRoot, url);

    if (!initialized.ok) {
      const { reason } = initialized;

      return { ok: false, reason: { code: syncFailureCode(reason), message: reason.message } };
    }

    return initialized;
  };

  return {
    initRemoteStore: runRemoteInit,
    syncStore: runSync,
    runBackgroundSync: runBackground,
    scheduleSync: runScheduleSync,
    fetchRemote: runFetch,
    mergeFetched: runMergeFetched,
  };
};
