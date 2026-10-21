#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import {
  appendFile,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

import { openCache } from './cache/cache.ts';
import type { CacheFiles, TicketCache } from './cache/cache.ts';
import { runCli } from './cli/cli.ts';
import type { CliEffects, CliSession } from './cli/cli.ts';
import { resolveMachine, resolveProject } from './project.ts';
import type { ConfigRead, GitOutcome, ProjectEffects } from './project.ts';
import type { Result } from './result.ts';
import {
  acquireStoreLock,
  tryStoreLock,
  appendFact,
  createTicketFile,
  initStore,
  listFactFiles,
  listTicketFiles,
  newIdSuffix,
  openStore,
  readFactFile,
  readTicketFile,
  resolveStoreRoot,
  writeTicketFile,
} from './store/store.ts';
import type {
  FactFileFunctions,
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

const homeDirectory = homedir();
const storeRoot = resolveStoreRoot({ tikkHome: Bun.env['TIKK_HOME'], homeDirectory });
const cachePath = join(homeDirectory, '.cache', 'tikk', 'index.db');

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
    const child = Bun.spawn(['git', ...args], {
      env: { ...Bun.env, GIT_TERMINAL_PROMPT: '0' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      ...(signal === undefined ? {} : { signal }),
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
    listFacts: (ticketIds) =>
      listFactsRecovering(cache, files, (ids) => cache.listFacts(ids), ticketIds),
    listStateFacts: (ticketIds) =>
      listFactsRecovering(cache, files, (ids) => cache.listStateFacts(ids), ticketIds),
    listArchiveFacts: () => listFactsRecovering(cache, files, () => cache.listArchiveFacts()),
    lockStore: () => acquireStoreLock(storeLock, store),
    tryLockStore: () => tryStoreLock(storeLock, store),
    appendFact: (machine, fact) => appendFact(factFiles, store, machine, fact),
    createTicketFile: (project, title, text) =>
      createTicketFile(ticketFiles, store, project, title, text),
    writeTicketFile: (path, expectedHash, text) =>
      writeTicketFile(ticketFiles, path, expectedHash, text),
    [Symbol.dispose]: () => {
      cache[Symbol.dispose]();
    },
  };
};

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

const syncFunctions: SyncFunctions = {
  runGit: runSyncGit,
  lockStore: () => acquireStoreLock(storeLock, { root: storeRoot }),
  stat: (path) => stat(path),
  readFile: (path) => readFile(path, 'utf8'),
  now: () => Date.now(),
  readdir: (directory) => readdir(directory),
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

// A compiled binary runs itself. Otherwise the child runs this script with the same Bun.
const backgroundCommand = (): string[] => {
  const compiled = Bun.main.startsWith('/$bunfs/');
  const entry = compiled ? [] : ['run', Bun.main];

  return [process.execPath, ...entry, 'sync', '--background'];
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
};

const syncFailureCode = (reason: SyncReason): 'conflict' | 'locked' | 'storeError' =>
  reason.kind === 'failed' ? 'storeError' : reason.kind;

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
    await runBackgroundSync(scheduleFunctions, store.value.root, () => runSync());
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

const runEditor = async (path: string): Promise<Result<undefined, { message: string }>> => {
  const editor = Bun.env['EDITOR'] ?? 'vi';
  const command = editor.split(/\s+/).filter((part) => part !== '');

  try {
    const child = Bun.spawn([...command, path], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });

    const exitCode = await child.exited;

    if (exitCode !== 0) {
      return { ok: false, reason: { message: `The editor "${editor}" exited with ${exitCode}.` } };
    }

    return { ok: true, value: undefined };
  } catch {
    return { ok: false, reason: { message: `Cannot run the editor "${editor}".` } };
  }
};

const projectEffects: ProjectEffects = {
  runGit: spawnGit,
  readConfigFile,
  homeDirectory,
  hostName: hostname(),
};

const effects: CliEffects = {
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
  readTextFile,
  runEditor,
  now: () => new Date(),
};

// The mutation test runner imports this file into its test process, where the CLI must not run.
if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2), effects, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
