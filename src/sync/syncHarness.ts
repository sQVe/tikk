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
  commands: () => string[];
  lockCalls: () => number;
  initCalls: () => number;
}

export interface FakeSyncOptions {
  // Returns the reply for a Git call, or `undefined` for the default success with no output.
  git?: (args: string[]) => GitReply | undefined;
  files?: Record<string, { text: string; mtimeMs: number }>;
  folder?: string[] | 'missing';
  lockFails?: boolean;
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
  let locked = false;
  let lockCount = 0;
  let initCount = 0;

  const functions: RemoteInitFunctions = {
    runGit: (args, signal) => {
      gitCalls.push({ args, signal: signal !== undefined, underLock: locked });

      return Promise.resolve(options.git?.(args) ?? gitOutput(''));
    },
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
      const file = options.files?.[path];

      return file === undefined ? missingFile() : Promise.resolve({ mtimeMs: file.mtimeMs });
    },
    readFile: (path) => {
      const file = options.files?.[path];

      return file === undefined ? missingFile() : Promise.resolve(file.text);
    },
    now: () => options.now ?? defaultNow,
    readdir: () => {
      const folder = options.folder ?? 'missing';

      return folder === 'missing' ? missingFile() : Promise.resolve(folder);
    },
    randomIdSuffix: () => 'zzzz',
    appendAlias: () => Promise.resolve({ ok: true, value: { path: 'facts/fake/2026-10.jsonl' } }),
    initStore: () => {
      initCount += 1;

      return Promise.resolve({ ok: true, value: { created: true } });
    },
  };

  return {
    functions,
    gitCalls,
    commands: () => gitCalls.map((call) => subcommandOf(call.args)),
    lockCalls: () => lockCount,
    initCalls: () => initCount,
  };
};
