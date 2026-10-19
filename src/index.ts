#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { openCache } from './cache/cache.ts';
import { runCli } from './cli/cli.ts';
import type { CliEffects, CliSession } from './cli/cli.ts';
import { resolveProject } from './project.ts';
import type { GitOutcome } from './project.ts';
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
import type { Store } from './store/store.ts';

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

const readTextFile = (path: string): Promise<string | undefined> =>
  readFile(path, 'utf8').catch(() => undefined);

const sessionFor = (store: Store): CliSession => {
  const cache = openCache(cachePath);

  return {
    refresh: () =>
      cache.refresh({
        listTicketFiles: () => listTicketFiles(store),
        readTicketFile,
      }),
    getTicket: (id) => cache.getTicket(id),
    listTickets: (options) => cache.listTickets(options),
    listErrors: () => cache.listErrors(),
    createTicketFile: (project, title, text) => createTicketFile(store, project, title, text),
    writeTicketFile,
    [Symbol.dispose]: () => {
      cache[Symbol.dispose]();
    },
  };
};

const openSession: CliEffects['openSession'] = async () => {
  const store = await openStore(storeRoot);

  if (store.ok) {
    return { ok: true, value: sessionFor(store.value) };
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
    const initialized = await initStore(storeRoot, { runGit: runStoreGit });

    if (!initialized.ok) {
      return initialized;
    }

    const { store, created } = initialized.value;

    return { ok: true, value: { store: store.root, created } };
  },
  openSession,
  resolveProject: () =>
    resolveProject(process.cwd(), { runGit: spawnGit, readTextFile, homeDirectory }),
  readTextFile,
  runEditor,
};

process.exitCode = await runCli(process.argv.slice(2), effects, {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
