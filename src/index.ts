#!/usr/bin/env bun
import { randomBytes } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { openNeedsSession, runCli } from './cli/cli.ts';
import type { CliEffects } from './cli/cli.ts';
import { configPathOf, readSettings } from './config.ts';
import { resolveMachine, resolveProject } from './project.ts';
import type { GitOutcome, ProjectEffects } from './project.ts';
import type { Result } from './result.ts';
import { createOpenSession } from './sessionEffects.ts';
import { initStore, resolveStoreRoot } from './store/store.ts';
import { storeFiles } from './storeEffects.ts';
import { defaultSyncDelays, parseSyncDelays } from './sync/sync.ts';
import type { SyncDelayFailure, SyncDelays } from './sync/sync.ts';
import { createSyncEffects } from './syncEffects.ts';

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

const readTextFile = (path: string): Promise<string | undefined> =>
  readFile(path, 'utf8').catch(() => undefined);

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

const editorKillDelayMilliseconds = 2000;
const editorReapDelayMilliseconds = 50;
// A cleanup failure waits this long for the editor to exit and be reaped, so the caller never sees a process that a signal has already ended. A process that refuses signals is not waited for longer than this.
const editorExitWaitMilliseconds = 1000;

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
      await Promise.race([child.exited, Bun.sleep(editorExitWaitMilliseconds)]);

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

const itemIdBytes = 6;

export const createEffects = (
  storeRoot: string,
  cachePath: string,
  syncDelays: SyncDelays = defaultSyncDelays,
): CliEffects => {
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

  const projectEffects: ProjectEffects = {
    runGit: spawnGit,
    readSettings: () => readSettings(homeDirectory),
    hostName: hostname(),
  };

  const syncEffects = createSyncEffects(storeRoot, initLocalStore, projectEffects, syncDelays);

  return {
    initStore: initLocalStore,
    initRemoteStore: syncEffects.initRemoteStore,
    syncStore: syncEffects.syncStore,
    runBackgroundSync: syncEffects.runBackgroundSync,
    scheduleSync: syncEffects.scheduleSync,
    fetchRemote: syncEffects.fetchRemote,
    mergeFetched: syncEffects.mergeFetched,
    openSession: createOpenSession(storeRoot, cachePath),
    resolveProject: () => resolveProject(process.cwd(), projectEffects),
    resolveMachine: () => Promise.resolve(resolveMachine(projectEffects)),
    runGh,
    readTextFile,
    runEditor,
    now: () => new Date(),
    newItemId: () => randomBytes(itemIdBytes).toString('hex'),
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
  const { loadBindings } = await import('./remap.ts');
  const config = loadBindings(readSettings(homeDirectory), configPathOf(homeDirectory));

  await startTerminal({
    needs: opened.value,
    watch: watchStore(defaultStoreRoot),
    bindings: config.bindings,
    notices: config.messages,
  });
};

const startsTerminal = (args: string[]): boolean =>
  args.length === 0 && process.stdin.isTTY && process.stdout.isTTY;

// Reports a rejected sync delay the way runCli reports a failed command.
const rejectSyncDelays = (args: string[], reason: SyncDelayFailure): number => {
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ error: reason })}\n`);
  } else {
    process.stderr.write(`${reason.message}\n`);
  }

  return 1;
};

// The mutation test runner imports this file into its test process, where the CLI must not run.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const syncDelays = parseSyncDelays(Bun.env);

  if (!syncDelays.ok) {
    process.exitCode = rejectSyncDelays(args, syncDelays.reason);
  } else {
    const effects = createEffects(defaultStoreRoot, defaultCachePath, syncDelays.value);

    if (startsTerminal(args)) {
      await runTerminal(effects);
    } else {
      process.exitCode = await runCli(args, effects, {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
      });
    }
  }
}
