import type { Result } from '../result.ts';
import type { RemoteInitFunctions } from './syncRemote.ts';

type GitReply = Result<string, { message: string }>;

interface GitCall {
  args: string[];
  signal: boolean;
  underLock: boolean;
}

export interface FakeSync {
  functions: RemoteInitFunctions;
  gitCalls: GitCall[];
  blobs: string[];
  renames: [string, string][];
  disk: Map<string, { text: string; mtimeMs: number }>;
  aliasWrites: () => number;
  commands: () => string[];
  lockCalls: () => number;
  initCalls: () => number;
}

export interface FakeSyncOptions {
  // Returns the reply for a Git call, or `undefined` for the default success with no output.
  git?: (args: string[]) => GitReply | undefined;
  files?: Record<string, { text: string; mtimeMs: number }>;
  folder?: string[] | 'missing';
  // Entries per directory path; a directory not listed here uses `folder`.
  folders?: Record<string, string[]>;
  lockFails?: boolean;
  // Runs before each `link` call, so a test can write a file at the target.
  beforeLink?: (path: string, disk: Map<string, { text: string; mtimeMs: number }>) => void;
  aliases?: { from: string; to: string; path: string }[];
  now?: number;
}

export const gitFailure = (message = 'git failed'): GitReply => ({
  ok: false,
  reason: { message },
});

export const gitOutput = (stdout: string): GitReply => ({ ok: true, value: stdout });

const defaultNow = 10_000;

const missingFile = (): Promise<never> =>
  Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));

// The subcommand follows the `-c` identity pairs and the `-C <root>` pair.
const subcommandOf = (args: string[]): string => {
  const index = args.indexOf('-C');
  const start = index === -1 ? 0 : index + 2;

  return args.slice(start).join(' ');
};

export const makeSync = (options: FakeSyncOptions = {}): FakeSync => {
  const gitCalls: GitCall[] = [];
  const blobs: string[] = [];
  let indexUpdates = 0;

  // The index tree differs from the `HEAD` tree once an `update-index` call has run.
  const defaultReply = (args: string[]): GitReply => {
    if (args.includes('write-tree')) {
      return gitOutput(`tree${indexUpdates}\n`);
    }

    return args.includes('HEAD^{tree}') ? gitOutput('tree0\n') : gitOutput('');
  };

  const renames: [string, string][] = [];
  const disk = new Map(Object.entries(options.files ?? {}));
  let aliasWrites = 0;
  let locked = false;
  let lockCount = 0;
  let initCount = 0;

  const functions: RemoteInitFunctions = {
    runGit: (args, signal) => {
      gitCalls.push({ args, signal: signal !== undefined, underLock: locked });

      if (args.includes('update-index')) {
        indexUpdates += 1;
      }

      return Promise.resolve(options.git?.(args) ?? defaultReply(args));
    },
    commitArguments: async (root) => {
      const email = await functions.runGit(['-C', root, 'config', 'user.email']);
      const configured = email.ok && email.value.trim() !== '';
      const unsigned = ['-c', 'commit.gpgsign=false'];

      return configured
        ? unsigned
        : [...unsigned, '-c', 'user.name=tikk', '-c', 'user.email=tikk@localhost'];
    },
    writeBlob: (_root, text) => {
      blobs.push(text);

      return Promise.resolve({ ok: true, value: `blob${blobs.length}\n` });
    },
    listAliases: () => Promise.resolve(options.aliases ?? []),
    lockStore: () => {
      lockCount += 1;

      if (options.lockFails === true) {
        return Promise.resolve({ ok: false, reason: { kind: 'locked', message: 'Store locked.' } });
      }

      locked = true;

      return Promise.resolve({
        ok: true,
        value: {
          release: () => {
            locked = false;

            return Promise.resolve();
          },
        },
      });
    },
    stat: (path) => {
      const file = disk.get(path);

      return file === undefined ? missingFile() : Promise.resolve({ mtimeMs: file.mtimeMs });
    },
    readFile: (path) => {
      const file = disk.get(path);

      // A fact file or config the test does not list reads as empty.
      if (file === undefined && !path.includes('/tickets/')) {
        return Promise.resolve('');
      }

      return file === undefined ? missingFile() : Promise.resolve(file.text);
    },
    now: () => options.now ?? defaultNow,
    readdir: (directory) => {
      const listed = options.folders?.[directory];

      if (listed !== undefined) {
        return Promise.resolve(listed);
      }

      const folder = options.folder ?? 'missing';

      return folder === 'missing' ? missingFile() : Promise.resolve(folder);
    },
    rename: (from, to) => {
      renames.push([from, to]);

      const file = disk.get(from);

      if (file !== undefined) {
        disk.set(to, file);
        disk.delete(from);
      }

      return Promise.resolve();
    },
    link: (existing, path) => {
      options.beforeLink?.(path, disk);

      const file = disk.get(existing);

      if (disk.has(path) || file === undefined) {
        return Promise.reject(Object.assign(new Error('exists'), { code: 'EEXIST' }));
      }

      disk.set(path, file);

      return Promise.resolve();
    },
    unlink: (path) => {
      disk.delete(path);

      return Promise.resolve();
    },
    randomIdSuffix: () => 'zzzz',
    appendAlias: () => {
      aliasWrites += 1;

      return Promise.resolve({ ok: true, value: { path: '/store/facts/fake/2026-10.jsonl' } });
    },
    initStore: () => {
      initCount += 1;

      return Promise.resolve({ ok: true, value: { created: true } });
    },
  };

  return {
    functions,
    gitCalls,
    blobs,
    renames,
    disk,
    aliasWrites: () => aliasWrites,
    commands: () => gitCalls.map((call) => subcommandOf(call.args)),
    lockCalls: () => lockCount,
    initCalls: () => initCount,
  };
};
