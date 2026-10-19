#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { openCache } from './cache/cache.ts';
import type { TicketCache } from './cache/cache.ts';
import { runCli } from './cli/cli.ts';
import type { CliEffects, CliSession } from './cli/cli.ts';
import { resolveProject } from './project.ts';
import type { ConfigRead, GitOutcome } from './project.ts';
import type { Result } from './result.ts';
import {
  createTicketFile,
  initStore,
  listTicketFiles,
  openStore,
  readTicketFile,
  resolveStoreRoot,
  writeTicketFile,
} from './store/store.ts';
import type { Store, StoreInitEffects, TicketFileFunctions } from './store/store.ts';

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

const sessionFor = (store: Store, cache: TicketCache): CliSession => ({
  refresh: () =>
    cache.refresh({
      listTicketFiles: () => listTicketFiles(ticketFiles, store),
      readTicketFile: (path) => readTicketFile(ticketFiles, path),
    }),
  getTicket: (id) => cache.getTicket(id),
  findTicketPath: (id) => cache.findTicketPath(id),
  listTickets: (options) => cache.listTickets(options),
  listErrors: () => cache.listErrors(),
  createTicketFile: (project, title, text) =>
    createTicketFile(ticketFiles, store, project, title, text),
  writeTicketFile: (path, expectedHash, text) =>
    writeTicketFile(ticketFiles, path, expectedHash, text),
  [Symbol.dispose]: () => {
    cache[Symbol.dispose]();
  },
});

const openSession: CliEffects['openSession'] = async () => {
  const store = await openStore(storeRoot, storeFiles);

  if (store.ok) {
    const cache = openCache(cachePath);

    if (!cache.ok) {
      return { ok: false, reason: { code: 'storeError', message: cache.reason.message } };
    }

    return { ok: true, value: sessionFor(store.value, cache.value) };
  }

  const configured = existsSync(join(storeRoot, 'tikk.json'));
  const code = configured ? 'storeError' : 'notInitialized';

  return { ok: false, reason: { code, message: store.reason.message } };
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

const effects: CliEffects = {
  initStore: async () => {
    const initialized = await initStore(storeRoot, { ...storeFiles, runGit: runStoreGit });

    if (!initialized.ok) {
      return initialized;
    }

    const { store, created } = initialized.value;

    return { ok: true, value: { store: store.root, created } };
  },
  openSession,
  resolveProject: () =>
    resolveProject(process.cwd(), { runGit: spawnGit, readConfigFile, homeDirectory }),
  readTextFile,
  runEditor,
};

// The mutation test runner imports this file into its test process, where the CLI must not run.
if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2), effects, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
