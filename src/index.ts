#!/usr/bin/env bun
import { existsSync, watch } from 'node:fs';
import type { Dirent } from 'node:fs';
import {
  appendFile,
  link,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { z } from 'zod';

import { openCache } from './cache/cache.ts';
import type { CacheFiles, TicketCache } from './cache/cache.ts';
import { openNeedsSession, runCli } from './cli/cli.ts';
import type { CliEffects, CliSession } from './cli/cli.ts';
import { parseFactLine } from './fact/fact.ts';
import { resolveMachine, resolveProject } from './project.ts';
import type { ConfigRead, GitOutcome, ProjectEffects } from './project.ts';
import type { Result } from './result.ts';
import {
  acquireStoreLock,
  tryStoreLock,
  appendFact,
  storeLog,
  commitArguments,
  createTicketFile,
  initStore,
  listFactFiles,
  listTicketFiles,
  newIdSuffix,
  openStore,
  readFactFile,
  readTicketFile,
  resolveStoreRoot,
  ticketFolderPath,
  writeTicketFile,
} from './store/store.ts';
import type {
  FactFileFunctions,
  LogFileFunctions,
  Store,
  StoreInitEffects,
  StoreLockFunctions,
  TicketFileFunctions,
} from './store/store.ts';
import {
  fetchOrigin,
  initRemoteStore,
  mergeFetched,
  runBackgroundSync,
  settlingPaths,
  scheduleSync,
  syncStore,
} from './sync/sync.ts';
import type {
  RemoteInitFunctions,
  SyncFunctions,
  SyncReason,
  SyncScheduleFunctions,
} from './sync/sync.ts';
import type { TicketId } from './ticket/ticket.ts';

type EditorCleanup = Result<undefined, { kind: 'cleanup'; message: string }>;

const homeDirectory = homedir();
const defaultStoreRoot = resolveStoreRoot({ tikkHome: Bun.env['TIKK_HOME'], homeDirectory });
const defaultCachePath = join(homeDirectory, '.cache', 'tikk', 'index.db');

const spawnGit = async (args: string[]): Promise<GitOutcome> => {
  try {
    const child = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'ignore' });
    const [stdout, exitCode] = await Promise.all([child.stdout.text(), child.exited]);

    return exitCode === 0 ? { kind: 'output', stdout } : { kind: 'failed' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'git did not start.';

    return { kind: 'unavailable', message };
  }
};

const runStoreGit = async (args: string[]): Promise<Result<string, { message: string }>> => {
  const outcome = await spawnGit(args);

  if (outcome.kind === 'output') {
    return { ok: true, value: outcome.stdout };
  }

  return { ok: false, reason: { message: `"git ${args.join(' ')}" failed.` } };
};

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

const ticketFiles: TicketFileFunctions = {
  readdir: (directory) => readdir(directory),
  stat: (path) => stat(path),
  readFile: (path) => readFile(path),
  mkdir: async (directory) => {
    await mkdir(directory, { recursive: true });
  },
  writeFileExclusive: async (path, text) => {
    const handle = await open(path, 'wx');
    const write = handle.writeFile(text);

    const succeeded = await write.then(
      () => true,
      () => false,
    );

    await handle.close();

    // This call created the file, so a failed write removes it, then rejects with the write error.
    if (!succeeded) {
      await unlink(path).catch(() => undefined);
    }

    await write;
  },
  writeFile: (path, text) => writeFile(path, text),
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
  randomIdSuffix: () => newIdSuffix(),
};

const logFiles: LogFileFunctions = {
  mkdir: ticketFiles.mkdir,
  writeFile: ticketFiles.writeFile,
  rename: ticketFiles.rename,
  unlink: ticketFiles.unlink,
  randomIdSuffix: ticketFiles.randomIdSuffix,
};

const factFiles: FactFileFunctions = {
  readdir: ticketFiles.readdir,
  stat: ticketFiles.stat,
  mkdir: ticketFiles.mkdir,
  readFileFrom: (path, fromByte) => Bun.file(path).slice(fromByte).bytes(),
  appendFile: (path, text) => appendFile(path, text),
};

const storeLock: StoreLockFunctions = {
  pid: process.pid,
  writeFile: (path, text) => writeFile(path, text),
  link: (existingPath, newPath) => link(existingPath, newPath),
  randomSuffix: () => crypto.randomUUID(),
  readFile: (path) => readFile(path, 'utf8'),
  unlink: ticketFiles.unlink,
  isProcessAlive: (pid) => {
    try {
      process.kill(pid, 0);

      return true;
    } catch (error) {
      return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
    }
  },
  sleep: (milliseconds) => Bun.sleep(milliseconds),
  now: () => Date.now(),
};

const storeFiles: Pick<StoreInitEffects, 'readFile' | 'mkdir' | 'writeFile'> = {
  readFile: (path) => readFile(path, 'utf8'),
  mkdir: ticketFiles.mkdir,
  writeFile: ticketFiles.writeFile,
};

const readTextFile = (path: string): Promise<string | undefined> =>
  readFile(path, 'utf8').catch(() => undefined);

const readConfigFile = async (path: string): Promise<ConfigRead> => {
  try {
    return { kind: 'text', text: await readFile(path, 'utf8') };
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';

    return missing ? { kind: 'missing' } : { kind: 'failed' };
  }
};

// A stored fact that does not decode means the cache is damaged. The fact tables are cleared and
// indexed again from the files once. A second failure is reported, not retried.
const listFactsRecovering = async (
  cache: TicketCache,
  files: CacheFiles,
  read: (ticketIds?: TicketId[]) => ReturnType<TicketCache['listFacts']>,
  ticketIds?: TicketId[],
): ReturnType<CliSession['listFacts']> => {
  const first = read(ticketIds);

  if (first.ok) {
    return first;
  }

  const refreshed = await cache.rebuildFacts(files);

  if (!refreshed.ok) {
    return refreshed;
  }

  const second = read(ticketIds);

  return second.ok ? second : { ok: false, reason: { message: second.reason.message } };
};

const isFolderFileEntry = (entry: Dirent): boolean => entry.isFile() || entry.isSymbolicLink();

const listTicketFolderFiles = async (
  folder: string,
): Promise<Result<string[], { message: string }>> => {
  try {
    const entries = await readdir(folder, { recursive: true, withFileTypes: true });

    const files = entries
      .filter((entry) => isFolderFileEntry(entry))
      .map((entry) => relative(folder, join(entry.parentPath, entry.name)));

    return { ok: true, value: files.toSorted() };
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';

    if (missing) {
      return { ok: true, value: [] };
    }

    return { ok: false, reason: { message: `Cannot list the files in ${folder}.` } };
  }
};

const sessionFor = (store: Store, cache: TicketCache): CliSession => {
  const files: CacheFiles = {
    listTicketFiles: () => listTicketFiles(ticketFiles, store),
    readTicketFile: (path) => readTicketFile(ticketFiles, path),
    listFactFiles: () => listFactFiles(factFiles, store),
    readFactFile: (path, fromByte) => readFactFile(factFiles, path, fromByte),
  };

  return {
    refresh: () => cache.refresh(files),
    getTicket: (id) => cache.getTicket(id),
    findTicketPath: (id) => cache.findTicketPath(id),
    listTickets: (options) => cache.listTickets(options),
    listTicketOutlines: () => cache.listTicketOutlines(),
    mayHaveArchiveWork: (now) => cache.mayHaveArchiveWork(now),
    listErrors: () => cache.listErrors(),
    listTicketFolderFiles: (project, id) =>
      listTicketFolderFiles(ticketFolderPath(store, project, id)),
    listFacts: (ticketIds) =>
      listFactsRecovering(cache, files, (ids) => cache.listFacts(ids), ticketIds),
    listStateFacts: (ticketIds) =>
      listFactsRecovering(cache, files, (ids) => cache.listStateFacts(ids), ticketIds),
    listArchiveFacts: () => listFactsRecovering(cache, files, () => cache.listArchiveFacts()),
    lockStore: () => acquireStoreLock(storeLock, store),
    tryLockStore: () => tryStoreLock(storeLock, store),
    appendFact: (machine, fact) => appendFact(factFiles, store, machine, fact),
    storeLog: async (text) => {
      const stored = await storeLog(logFiles, store, text);

      return stored.ok ? stored : { ok: false, reason: { message: stored.reason.message } };
    },
    createTicketFile: (project, title, text) =>
      createTicketFile(ticketFiles, store, project, title, text),
    writeTicketFile: (path, expectedHash, text) =>
      writeTicketFile(ticketFiles, path, expectedHash, text),
    [Symbol.dispose]: () => {
      cache[Symbol.dispose]();
    },
  };
};

// GH_PROMPT_DISABLED makes gh fail instead of asking questions, since no one may be at the terminal.
const runGh: CliEffects['runGh'] = async (args, signal) => {
  try {
    const child = Bun.spawn(['gh', ...args], {
      env: { ...Bun.env, GH_PROMPT_DISABLED: '1' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      signal,
      killSignal: 'SIGKILL',
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      child.stdout.text(),
      child.stderr.text(),
      child.exited,
    ]);

    if (signal.aborted) {
      return { ok: false, reason: { message: `"gh ${args.join(' ')}" did not finish in time.` } };
    }

    if (exitCode === 0) {
      return { ok: true, value: stdout };
    }

    return { ok: false, reason: { message: `"gh ${args.join(' ')}" failed: ${stderr.trim()}` } };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'gh did not start.';

    return { ok: false, reason: { message } };
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

const editorKillDelayMilliseconds = 2000;
const editorReapDelayMilliseconds = 50;

const processRowSchema = z.tuple([
  z.coerce.number().int().positive(),
  z.coerce.number().int().nonnegative(),
]);

const descendantProcessIds = (roots: readonly number[], rows: [number, number][]): number[] => {
  const owned = new Set(roots);
  const pending = [...roots];

  for (const parent of pending) {
    for (const [pid, parentPid] of rows) {
      if (parentPid === parent && !owned.has(pid)) {
        owned.add(pid);
        pending.push(pid);
      }
    }
  }

  return pending;
};

const editorProcessTree = (
  roots: readonly number[],
): Result<number[], { kind: 'cleanup'; message: string }> => {
  try {
    const listing = Bun.spawnSync(['ps', '-A', '-o', 'pid=', '-o', 'ppid='], {
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 500,
      killSignal: 'SIGKILL',
    });

    if (!listing.success) {
      return { ok: false, reason: { kind: 'cleanup', message: 'Cannot list editor processes.' } };
    }

    const lines = listing.stdout.toString().trim().split('\n');
    const rows = lines.map((line) => line.trim().split(/\s+/));
    const parsed = z.array(processRowSchema).safeParse(rows);

    if (!parsed.success) {
      return {
        ok: false,
        reason: { kind: 'cleanup', message: 'Cannot read the editor process list.' },
      };
    }

    return { ok: true, value: descendantProcessIds(roots, parsed.data) };
  } catch {
    return { ok: false, reason: { kind: 'cleanup', message: 'Cannot list editor processes.' } };
  }
};

const signalEditorProcesses = (pids: readonly number[], signal: NodeJS.Signals): EditorCleanup => {
  let failure: EditorCleanup | undefined;

  // Editors share tikk's foreground terminal group. Only signal owned positive PIDs.
  for (const pid of pids.toReversed()) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      const missing = error instanceof Error && 'code' in error && error.code === 'ESRCH';

      if (!missing) {
        failure ??= {
          ok: false,
          reason: { kind: 'cleanup', message: `Cannot stop editor process ${pid}.` },
        };
      }
    }
  }

  return failure ?? { ok: true, value: undefined };
};

const stopEditorTree = async (editorPid: number): Promise<EditorCleanup> => {
  const tree = editorProcessTree([editorPid]);
  const owned = tree.ok ? tree.value : [editorPid];
  const descendants = owned.filter((pid) => pid !== editorPid);
  const targets = descendants.length === 0 ? owned : descendants;
  const terminated = signalEditorProcesses(targets, 'SIGTERM');

  await Bun.sleep(editorKillDelayMilliseconds);

  const remaining = editorProcessTree(owned);
  const remainingPids = remaining.ok ? remaining.value : owned;
  const remainingDescendants = remainingPids.filter((pid) => pid !== editorPid);
  const killed = signalEditorProcesses(remainingDescendants, 'SIGKILL');

  if (remainingDescendants.length > 0) {
    await Bun.sleep(editorReapDelayMilliseconds);
  }

  const stopped = signalEditorProcesses([editorPid], 'SIGKILL');

  for (const result of [tree, terminated, remaining, killed, stopped]) {
    if (!result.ok) {
      return result;
    }
  }

  return { ok: true, value: undefined };
};

const runEditor: CliEffects['runEditor'] = async (path, signal) => {
  const editor = Bun.env['EDITOR'] ?? 'vi';
  const command = editor.split(/\s+/).filter((part) => part !== '');

  try {
    const child = Bun.spawn([...command, path], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });

    const interrupted = Promise.withResolvers<EditorCleanup>();
    let stopping: Promise<EditorCleanup> | undefined;

    const stop = () => {
      stopping ??= stopEditorTree(child.pid);
      interrupted.resolve(stopping);
    };

    signal.addEventListener('abort', stop, { once: true });

    if (signal.aborted) {
      stop();
    }

    try {
      await Promise.race([child.exited, interrupted.promise]);
    } finally {
      signal.removeEventListener('abort', stop);
    }

    const cleanup = await stopping;

    if (cleanup !== undefined && !cleanup.ok) {
      return cleanup;
    }

    const exitCode = await child.exited;

    if (signal.aborted) {
      return {
        ok: false,
        reason: { kind: 'cancelled', message: `The editor "${editor}" was stopped.` },
      };
    }

    if (exitCode !== 0) {
      return {
        ok: false,
        reason: { kind: 'failed', message: `The editor "${editor}" exited with ${exitCode}.` },
      };
    }

    return { ok: true, value: undefined };
  } catch {
    return { ok: false, reason: { kind: 'failed', message: `Cannot run the editor "${editor}".` } };
  }
};

const syncFailureCode = (reason: SyncReason): 'conflict' | 'locked' | 'storeError' =>
  reason.kind === 'failed' ? 'storeError' : reason.kind;

export const createEffects = (storeRoot: string, cachePath: string): CliEffects => {
  const openFailureCode = (): 'storeError' | 'notInitialized' => {
    const configured = existsSync(join(storeRoot, 'tikk.json'));

    return configured ? 'storeError' : 'notInitialized';
  };

  const openSession: CliEffects['openSession'] = async () => {
    const store = await openStore(storeRoot, storeFiles);

    if (store.ok) {
      const cache = openCache(cachePath);

      if (!cache.ok) {
        return { ok: false, reason: { code: 'storeError', message: cache.reason.message } };
      }

      return { ok: true, value: sessionFor(store.value, cache.value) };
    }

    return { ok: false, reason: { code: openFailureCode(), message: store.reason.message } };
  };

  const initLocalStore = async (): Promise<
    Result<{ store: string; created: boolean }, { message: string }>
  > => {
    const initialized = await initStore(storeRoot, { ...storeFiles, runGit: runStoreGit });

    if (!initialized.ok) {
      return initialized;
    }

    const { store, created } = initialized.value;

    return { ok: true, value: { store: store.root, created } };
  };

  const listAliases: SyncFunctions['listAliases'] = async () => {
    const machine = await resolveMachine(projectEffects);

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
      const machine = await resolveMachine(projectEffects);

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
      return { ok: false, reason: { code: openFailureCode(), message: store.reason.message } };
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

  const projectEffects: ProjectEffects = {
    runGit: spawnGit,
    readConfigFile,
    homeDirectory,
    hostName: hostname(),
  };

  return {
    initStore: initLocalStore,
    initRemoteStore: runRemoteInit,
    syncStore: runSync,
    runBackgroundSync: runBackground,
    scheduleSync: runScheduleSync,
    fetchRemote: runFetch,
    mergeFetched: runMergeFetched,
    openSession,
    resolveProject: () => resolveProject(process.cwd(), projectEffects),
    resolveMachine: () => resolveMachine(projectEffects),
    runGh,
    readTextFile,
    runEditor,
    now: () => new Date(),
  };
};

const watchedFolders = new Set(['tickets', 'facts']);

const isWatchedPath = (path: string | null): boolean => {
  const [folder] = (path ?? '').split(/[\\/]/);

  return folder !== undefined && watchedFolders.has(folder);
};

// The store root is watched because `tickets/` and `facts/` appear only with their first file.
export const watchStore =
  (storeRoot: string) =>
  (onChange: () => void): (() => void) => {
    const watcher = watch(storeRoot, { recursive: true }, (_event, path) => {
      if (isWatchedPath(path)) {
        onChange();
      }
    });

    return () => {
      watcher.close();
    };
  };

const runTerminal = async (effects: CliEffects): Promise<void> => {
  const opened = await openNeedsSession(effects);

  if (!opened.ok) {
    process.stderr.write(`${opened.reason.message}\n`);
    process.exitCode = 1;

    return;
  }

  const { startTerminal } = await import('./terminal.tsx');

  await startTerminal({ needs: opened.value, watch: watchStore(defaultStoreRoot) });
};

const startsTerminal = (args: string[]): boolean =>
  args.length === 0 && process.stdin.isTTY && process.stdout.isTTY;

// The mutation test runner imports this file into its test process, where the CLI must not run.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const effects = createEffects(defaultStoreRoot, defaultCachePath);

  if (startsTerminal(args)) {
    await runTerminal(effects);
  } else {
    process.exitCode = await runCli(args, effects, {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
  }
}
